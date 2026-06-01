import { Db, MongoClient } from "mongodb";
import { config } from "./config";

let clientPromise: Promise<MongoClient> | null = null;

async function connectMongoClient(): Promise<MongoClient> {
  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  return client;
}

export async function getMongoClient(): Promise<MongoClient> {
  if (!clientPromise) {
    clientPromise = connectMongoClient().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }

  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(config.mongo.dbName);
}
