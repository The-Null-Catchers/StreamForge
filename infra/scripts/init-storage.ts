import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { storage } from "../../packages/shared/src/storage.js";
import { config } from "../../packages/config/src/index.js";
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    await storage.client.send(
      new CreateBucketCommand({ Bucket: config.S3_BUCKET }),
    );
    ready = true;
    break;
  } catch (error) {
    const name = (error as { name: string }).name;
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      await storage.client.send(
        new HeadBucketCommand({ Bucket: config.S3_BUCKET }),
      );
      ready = true;
      break;
    }
    if (attempt === 59) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
if (!ready) throw Error("Storage did not become ready");
console.log("Private development bucket is ready.");
storage.client.destroy();
