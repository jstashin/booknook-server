import express from "express";
import { MongoClient } from "mongodb";
import "dotenv/config";
import cors from "cors";

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
  })
);

app.use(express.json());

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from .env");
}

const client = new MongoClient(process.env.MONGODB_URI);
export async function connectToMongoDB() {
  try {
    await client.connect();

    console.log("You successfully connected to MongoDB!");

    return client;
  } catch (error) {
    // Connection fail হলে নিচের code আর চলবে না।
    throw error;
  }
}

async function startServer() {
  const mongoClient = await connectToMongoDB();

  // Database and collections
  const db = mongoClient.db("booknook");

  const booksCollection = db.collection("books");
  const borrowsCollection = db.collection("borrows");

  // borrowsCollection পরের ধাপে ব্যবহার করব।

  await booksCollection.createIndex({ createdAt: -1 });

  // Public: get all books or newest six books
  app.get("/books", async (req, res) => {
    try {
      const { limit } = req.query;

      const cursor = booksCollection
        .find({})
        .sort({ createdAt: -1, _id: -1 });

      if (limit !== undefined) {
        const parsedLimit = Number(limit);

        if (
          !Number.isInteger(parsedLimit) ||
          parsedLimit < 1 ||
          parsedLimit > 100
        ) {
          return res.status(400).send({
            message: "Limit must be an integer between 1 and 100.",
          });
        }

        cursor.limit(parsedLimit);
      }

      const result = await cursor.toArray();

      res.send(result);
    } catch (error) {
      console.error("Failed to fetch books:", error.message);

      res.status(500).send({
        message: "Failed to load books. Please try again.",
      });
    }
  });

  app.listen(port, () => {
    console.log(`BookNook server is running on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});