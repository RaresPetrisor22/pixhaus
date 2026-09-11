// The one place the SPA talks to the API. Same origin, so the session cookie
// rides along on its own; the client plane's bearer token is passed explicitly.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type Profile = {
  user: { id: string; email: string; role: string; emailVerified: boolean };
  studio: { id: string; name: string; slug: string };
};

type Options = { body?: unknown; bearer?: string };

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function request<T>(method: string, path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;

  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const json = parseJson(await response.text());

  if (!response.ok) {
    const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'unknown',
      error?.message ?? `Request failed (${response.status}).`,
    );
  }

  return json as T;
}

export const api = {
  get: <T>(path: string, options?: Options) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: Options) =>
    request<T>('POST', path, { ...options, body }),
  delete: (path: string, options?: Options) => request<void>('DELETE', path, options),
};

export function describe(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}
