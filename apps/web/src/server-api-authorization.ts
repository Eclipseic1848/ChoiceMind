export function addChoiceMindApiAuthorization(headers: Headers, request?: Request): Headers {
  const cookie = request?.headers.get("cookie");
  if (cookie !== null && cookie !== undefined && cookie.length > 0) {
    headers.set("Cookie", cookie);
  }

  const authorization = process.env.CHOICEMIND_API_AUTHORIZATION;

  if (authorization === undefined || authorization.length === 0) {
    return headers;
  }

  if (!authorization.startsWith("Bearer ") || authorization.length === "Bearer ".length) {
    throw new Error("CHOICEMIND_API_AUTHORIZATION 必须是非空 Bearer Token");
  }

  headers.set("Authorization", authorization);
  return headers;
}
