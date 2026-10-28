// Reads and writes the library in a GitHub repo, one commit per save.

const API = 'https://api.github.com';

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Repo {
  constructor({ owner, repo, branch, token }) {
    Object.assign(this, { owner, repo, branch, token });
    this.base = `/repos/${owner}/${repo}`;
  }

  async call(path, { method = 'GET', body, raw = false } = {}) {
    const response = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new GitHubError(`GitHub ${response.status}: ${detail?.message ?? response.statusText}`, response.status);
    }
    if (raw) return response.text();
    return response.status === 204 ? null : response.json();
  }

  // True when the token may push to this repo.
  async canWrite() {
    const info = await this.call(this.base);
    return info.permissions?.push === true;
  }

  // File text at a branch or commit, or null when it doesn't exist.
  async readText(path, ref) {
    try {
      return await this.call(`${this.base}/contents/${path}?ref=${encodeURIComponent(ref)}`, { raw: true });
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // build(headSha) returns [{ path, text } | { path, bytes } | { path, delete: true }].
  // If someone else pushed in the meantime, it rebuilds on the new head and tries again.
  async commit(message, build, onProgress) {
    const blobs = new Map();
    for (let attempt = 0; ; attempt++) {
      const ref = await this.call(`${this.base}/git/ref/heads/${this.branch}`);
      const head = ref.object.sha;
      const parent = await this.call(`${this.base}/git/commits/${head}`);
      const files = await build(head);
      const uploads = files.filter((f) => f.bytes != null);
      const tree = [];
      for (const f of files) {
        const entry = { path: f.path, mode: '100644', type: 'blob' };
        if (f.delete) tree.push({ ...entry, sha: null });
        else if (f.text != null) tree.push({ ...entry, content: f.text });
        else {
          if (!blobs.has(f.path)) {
            onProgress?.(blobs.size + 1, uploads.length);
            const blob = await this.call(`${this.base}/git/blobs`, {
              method: 'POST',
              body: { content: toBase64(f.bytes), encoding: 'base64' },
            });
            blobs.set(f.path, blob.sha);
          }
          tree.push({ ...entry, sha: blobs.get(f.path) });
        }
      }
      const newTree = await this.call(`${this.base}/git/trees`, {
        method: 'POST',
        body: { base_tree: parent.tree.sha, tree },
      });
      const commit = await this.call(`${this.base}/git/commits`, {
        method: 'POST',
        body: { message, tree: newTree.sha, parents: [head] },
      });
      try {
        await this.call(`${this.base}/git/refs/heads/${this.branch}`, { method: 'PATCH', body: { sha: commit.sha } });
        return commit.sha;
      } catch (e) {
        if (e.status !== 422 || attempt >= 2) throw e;
      }
    }
  }
}
