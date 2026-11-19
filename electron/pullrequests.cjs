'use strict';
// Finds the open pull requests of a repository on GitHub or Azure DevOps (read only).
// Pure helpers: callers pass in the token and a fetch function, so everything here can be tested
// without a network. A token is only ever sent to the provider's own API host.

const NAME = '[A-Za-z0-9._-]+';
const GITHUB_HTTPS = new RegExp(`^https?://(?:[^@/]+@)?github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i');
const GITHUB_SSH = new RegExp(`^(?:ssh://)?git@github\\.com[:/](${NAME})/(${NAME}?)(?:\\.git)?/?$`, 'i');
const AZURE_HTTPS = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)\/?$/i;
const AZURE_LEGACY = /^https:\/\/(?:[^@/]+@)?([^./@]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)\/?$/i;
const AZURE_SSH = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+?)\/?$/i;

// Tests point both providers at a local fake server with this variable. It is not a user setting.
function apiBase(provider) {
  const override = process.env.GITGUI_PR_API_BASE;
  if (override) return override.replace(/\/$/, '');
  return provider === 'github' ? 'https://api.github.com' : 'https://dev.azure.com';
}

const enc = (s) => encodeURIComponent(decodeURIComponent(s));

/**
 * Recognises a remote URL of GitHub or Azure DevOps (https or ssh) and works out where the
 * repository's web pages and API live. Returns null for any other host.
 */
function parseRemoteUrl(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  let m = GITHUB_HTTPS.exec(u) || GITHUB_SSH.exec(u);
  if (m) {
    const [, owner, repo] = m;
    return {
      provider: 'github',
      credentialHost: 'github.com',
      name: `${owner}/${repo}`,
      webUrl: `https://github.com/${owner}/${repo}`,
      listUrl: `https://github.com/${owner}/${repo}/pulls`,
      owner,
      repo,
    };
  }
  m = AZURE_HTTPS.exec(u) || AZURE_LEGACY.exec(u) || AZURE_SSH.exec(u);
  if (m) {
    let [, org, project, repo] = m;
    try {
      project = enc(project);
      repo = enc(repo);
    } catch {
      return null; // a malformed % escape
    }
    const legacy = AZURE_LEGACY.test(u);
    const web = `https://dev.azure.com/${org}/${project}/_git/${repo}`;
    return {
      provider: 'azure',
      credentialHost: legacy ? `${org}.visualstudio.com` : 'dev.azure.com',
      credentialPath: `${org}/${project}/_git/${repo}`,
      name: `${org}/${decodeURIComponent(project)}/${decodeURIComponent(repo)}`,
      webUrl: web,
      listUrl: `${web}/pullrequests`,
      org,
      project,
      repo,
    };
  }
  return null;
}

/** The pull request page for a number, built from the parsed remote and never from API data. */
function pullRequestUrl(info, number) {
  return info.provider === 'github' ? `${info.webUrl}/pull/${number}` : `${info.webUrl}/pullrequest/${number}`;
}

/** `git credential fill` prints key=value lines; the password is the token. */
function parseCredentialOutput(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out.password ? { username: out.username || '', token: out.password } : null;
}

// Azure DevOps hands out two kinds of credentials: personal access tokens (Basic) and Microsoft
// sign-in tokens, which are JWTs (Bearer).
const looksLikeJwt = (t) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(t);

function headers(info, token) {
  const h = { 'User-Agent': 'GitGui', Accept: 'application/json' };
  if (info.provider === 'github') {
    h.Accept = 'application/vnd.github+json';
    h['X-GitHub-Api-Version'] = '2022-11-28';
    if (token) h.Authorization = `Bearer ${token}`;
  } else if (token) {
    h.Authorization = looksLikeJwt(token) ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  }
  return h;
}

function endpoint(info) {
  const base = apiBase(info.provider);
  if (info.provider === 'github') return `${base}/repos/${info.owner}/${info.repo}/pulls?state=open&per_page=100`;
  return `${base}/${info.org}/${info.project}/_apis/git/repositories/${info.repo}/pullrequests?searchCriteria.status=active&$top=100&api-version=7.1`;
}

function mapGithub(info, list) {
  return list
    .filter((p) => p && Number.isInteger(p.number) && p.head && typeof p.head.ref === 'string')
    .map((p) => ({
      number: p.number,
      title: String(p.title || ''),
      url: pullRequestUrl(info, p.number),
      branch: p.head.ref,
      target: p.base && typeof p.base.ref === 'string' ? p.base.ref : '',
      author: p.user && p.user.login ? String(p.user.login) : '',
      draft: !!p.draft,
      // a pull request from a fork has a branch of its own that must not be matched to ours
      fork: !!(p.head.repo && p.base && p.base.repo && p.head.repo.full_name !== p.base.repo.full_name),
    }));
}

function mapAzure(info, body) {
  const list = body && Array.isArray(body.value) ? body.value : [];
  const branch = (ref) => String(ref || '').replace(/^refs\/heads\//, '');
  return list
    .filter((p) => p && Number.isInteger(p.pullRequestId))
    .map((p) => ({
      number: p.pullRequestId,
      title: String(p.title || ''),
      url: pullRequestUrl(info, p.pullRequestId),
      branch: branch(p.sourceRefName),
      target: branch(p.targetRefName),
      author: p.createdBy && p.createdBy.displayName ? String(p.createdBy.displayName) : '',
      draft: !!p.isDraft,
      fork: !!p.forkSource,
    }));
}

function explain(info, status, authenticated) {
  if (status === 401) return 'The login was not accepted.';
  if (status === 403) return info.provider === 'github' ? 'GitHub refused the request (rate limit or no access).' : 'Azure DevOps refused the request (no access).';
  if (status === 404) return authenticated ? 'The repository was not found, or this login cannot see it.' : 'The repository was not found. For a private repository, sign in with Git Credential Manager.';
  return `The server answered ${status}.`;
}

/**
 * Lists the open pull requests. Never throws: problems come back as `error` so the UI can show
 * them quietly. `fetchImpl` is injectable for tests.
 */
async function listPullRequests(info, token, fetchImpl = globalThis.fetch) {
  const get = (tok) =>
    fetchImpl(endpoint(info), { headers: headers(info, tok), signal: AbortSignal.timeout(12000), redirect: 'follow' });
  try {
    let res = await get(token);
    let used = !!token;
    if (res.status === 401 && token) {
      // a stale token also blocks public repositories: try once without it
      res = await get(null);
      used = false;
    }
    if (!res.ok) return { prs: [], error: explain(info, res.status, used), authenticated: used };
    const body = await res.json();
    const prs = info.provider === 'github' ? mapGithub(info, Array.isArray(body) ? body : []) : mapAzure(info, body);
    return { prs, authenticated: used };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { prs: [], error: timedOut ? 'Timed out reaching the server.' : 'Could not reach the server (offline?).', authenticated: !!token };
  }
}

module.exports = { parseRemoteUrl, pullRequestUrl, parseCredentialOutput, listPullRequests, looksLikeJwt };
