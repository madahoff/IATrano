// Client HTTP du navigateur vers les routes /api du serveur Next.js (jamais directement vers le moteur IA).

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export async function readApiError(res: Response): Promise<ApiError> {
  try {
    const data = (await res.json()) as { error?: { message?: string; code?: string } };
    return new ApiError(data.error?.message ?? `Erreur ${res.status}`, res.status, data.error?.code);
  } catch {
    return new ApiError(res.status >= 500 ? "Le serveur ne répond pas correctement." : `Erreur ${res.status}`, res.status);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("Connexion au serveur impossible. Vérifiez votre réseau.", 0, "network");
  }
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    window.location.href = "/login";
  }
  if (!res.ok) throw await readApiError(res);
  return (await res.json()) as T;
}
