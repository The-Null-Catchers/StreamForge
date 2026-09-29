let refreshing: Promise<void> | null = null;
export function session() {
  return typeof window === "undefined"
    ? null
    : sessionStorage.getItem("sf_access");
}
export function saveSession(value: {
  accessToken: string;
  refreshToken: string;
}) {
  sessionStorage.setItem("sf_access", value.accessToken);
  sessionStorage.setItem("sf_refresh", value.refreshToken);
}
export async function api<T = any>(
  path: string,
  init: RequestInit = {},
  retry = true,
): Promise<T> {
  const r = await fetch("/api/v1" + path, {
    ...init,
    headers: {
      ...(init.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(session() ? { Authorization: `Bearer ${session()}` } : {}),
      ...init.headers,
    },
  });
  if (r.status === 401 && retry && sessionStorage.getItem("sf_refresh")) {
    if (!refreshing)
      refreshing = (async () => {
        const result = await fetch("/api/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            refreshToken: sessionStorage.getItem("sf_refresh"),
          }),
        });
        if (!result.ok) {
          sessionStorage.clear();
          throw Error("Your session expired. Sign in again.");
        }
        saveSession(await result.json());
      })().finally(() => {
        refreshing = null;
      });
    await refreshing;
    return api<T>(path, init, false);
  }
  const body = await r.json();
  if (!r.ok) throw Error(body.error?.message ?? "Request failed");
  return body as T;
}
export const post = (path: string, body: unknown) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
