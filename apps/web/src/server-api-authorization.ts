export function addChoiceMindApiAuthorization(headers: Headers): Headers {
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
