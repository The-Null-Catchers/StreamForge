import { readFile } from "node:fs/promises";

const spec = JSON.parse(
  await readFile(new URL("../../docs/openapi.json", import.meta.url), "utf8"),
);
const sdkPackage = JSON.parse(
  await readFile(
    new URL("../../packages/sdk/package.json", import.meta.url),
    "utf8",
  ),
);

if (spec.openapi !== "3.1.0") throw Error("OPENAPI_VERSION_MUST_BE_3_1_0");
if (spec.info?.version !== sdkPackage.version)
  throw Error("OPENAPI_AND_SDK_VERSION_MISMATCH");
if (!spec.components?.securitySchemes?.bearerAuth)
  throw Error("OPENAPI_BEARER_AUTH_MISSING");

const paths = Object.entries(spec.paths ?? {});
if (paths.length < 20) throw Error("OPENAPI_PATH_COVERAGE_TOO_SMALL");

const operationIds = new Set<string>();
let operations = 0;
for (const [path, item] of paths) {
  if (!path.startsWith("/api/v1/"))
    throw Error(`OPENAPI_PUBLIC_PATH_INVALID:${path}`);
  for (const method of [
    "get",
    "post",
    "put",
    "patch",
    "delete",
  ] as const) {
    const operation = (item as Record<string, any>)[method];
    if (!operation) continue;
    operations++;
    if (!operation.operationId)
      throw Error(`OPENAPI_OPERATION_ID_MISSING:${method.toUpperCase()} ${path}`);
    if (operationIds.has(operation.operationId))
      throw Error(`OPENAPI_DUPLICATE_OPERATION_ID:${operation.operationId}`);
    operationIds.add(operation.operationId);
    if (!operation.responses || !Object.keys(operation.responses).length)
      throw Error(`OPENAPI_RESPONSES_MISSING:${operation.operationId}`);
  }
}

for (const required of [
  "createVideo",
  "createUpload",
  "completeUpload",
  "getPlayback",
  "getVideoAnalytics",
  "createTranscription",
  "createAiGeneration",
  "createLiveStream",
  "getLivePlayback",
  "createApiKey",
  "createWebhook",
])
  if (!operationIds.has(required))
    throw Error(`OPENAPI_REQUIRED_OPERATION_MISSING:${required}`);

if (operations < 30) throw Error("OPENAPI_OPERATION_COVERAGE_TOO_SMALL");
console.log(
  `OpenAPI contract valid: ${paths.length} paths, ${operations} operations, version ${spec.info.version}`,
);
