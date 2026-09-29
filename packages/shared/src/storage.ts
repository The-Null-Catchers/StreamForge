import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { config } from "../../config/src/index.js";
export interface ObjectStorage {
  put(
    key: string,
    body: Buffer | Readable,
    type?: string,
    size?: number,
  ): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSignedUrl(key: string, expires?: number): Promise<string>;
}
export class S3Storage implements ObjectStorage {
  client = new S3Client({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    forcePathStyle: config.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY,
      secretAccessKey: config.S3_SECRET_KEY,
    },
  });
  async put(
    key: string,
    body: Buffer | Readable,
    type = "application/octet-stream",
    size?: number,
  ) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: type,
        ContentLength: size,
      }),
    );
  }
  async get(key: string) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    );
    return r.Body as Readable;
  }
  async delete(key: string) {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    );
  }
  async exists(key: string) {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
      );
      return true;
    } catch (e) {
      if ((e as { name: string }).name === "NotFound") return false;
      throw e;
    }
  }
  getSignedUrl(key: string, expires = 300) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
      { expiresIn: expires },
    );
  }
  async ready() {
    await this.client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  }
  async deletePrefix(prefix: string) {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: config.S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      if (r.Contents?.length) {
        const d = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: config.S3_BUCKET,
            Delete: { Objects: r.Contents.map((x) => ({ Key: x.Key! })) },
          }),
        );
        if (d.Errors?.length) throw Error("STORAGE_DELETE_FAILED");
      }
      token = r.NextContinuationToken;
    } while (token);
  }
}
export const storage = new S3Storage();
export const videoPrefix = (workspace: string, video: string) =>
  `workspaces/${workspace}/videos/${video}/`;
