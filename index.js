import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
const port = Number(process.env.PORT || 5000);
const clientUrl = new URL(
  process.env.CLIENT_URL || "http://localhost:3000"
).origin;

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from .env");
}

const client = new MongoClient(process.env.MONGODB_URI);
const jwks = createRemoteJWKSet(new URL("/api/auth/jwks", clientUrl));

const categories = ["Fiction", "Science", "History", "Kids", "Others"];

const listFields = {
  title: 1,
  author: 1,
  category: 1,
  image: 1,
  totalCopies: 1,
  availableCopies: 1,
  createdAt: 1,
};

app.use(cors({ origin: clientUrl }));
app.use(express.json());

async function verifyToken(req, res, next) {
  const token = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];

  if (!token) {
    return res.status(401).json({ message: "Please log in to continue." });
  }

  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: clientUrl,
      audience: clientUrl,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "exp"],
    });

    if (
      typeof payload.sub !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.email !== "string"
    ) {
      return res.status(401).json({ message: "Invalid user identity." });
    }

    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
    };
  } catch {
    return res.status(401).json({
      message: "Authentication could not be verified. Please log in again.",
    });
  }

  return next();
}

function validText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

function readBookFields(body, allowedCoverHosts) {
  const { title, author, category, description, image, totalCopies } = body || {};

  if (
    !validText(title, 150) ||
    !validText(author, 100) ||
    !validText(description, 2000) ||
    !categories.includes(category) ||
    !Number.isInteger(totalCopies) ||
    totalCopies < 1 ||
    totalCopies > 10000
  ) {
    return { error: "Check the book details and total copies." };
  }

  let cover;

  try {
    cover = new URL(image);
  } catch {
    return { error: "Invalid cover URL." };
  }

  if (
    cover.protocol !== "https:" ||
    !allowedCoverHosts.includes(cover.hostname)
  ) {
    return { error: "Use a supported book cover URL." };
  }

  return {
    book: {
      title: title.trim(),
      author: author.trim(),
      category,
      description: description.trim(),
      image: cover.href,
      totalCopies,
    },
  };
}

export async function connectToMongoDB() {
  await client.connect();
  console.log("MongoDB connected successfully.");
  return client;
}

async function startServer() {
  const mongoClient = await connectToMongoDB();
  const db = mongoClient.db("booknook");
  const booksCollection = db.collection("books");

  await booksCollection.createIndex({ createdAt: -1, _id: -1 });

  app.get(
    "/books",
    (req, res, next) => {
      if (req.query.mine === "true") {
        return verifyToken(req, res, next);
      }

      return next();
    },
    async (req, res) => {
      try {
        const { limit, mine } = req.query;
        const ownBooks = mine === "true";
        const filter = ownBooks ? { ownerId: req.user.id } : {};
        const projection = ownBooks
          ? { ...listFields, description: 1 }
          : listFields;

        const cursor = booksCollection
          .find(filter, { projection })
          .sort({ createdAt: -1, _id: -1 });

        if (limit !== undefined) {
          const parsedLimit = Number(limit);

          if (
            typeof limit !== "string" ||
            !Number.isInteger(parsedLimit) ||
            parsedLimit < 1 ||
            parsedLimit > 100
          ) {
            return res.status(400).json({
              message: "Limit must be an integer between 1 and 100.",
            });
          }

          cursor.limit(parsedLimit);
        }

        return res.json(await cursor.toArray());
      } catch (error) {
        console.error("Failed to fetch books:", error.message);
        return res.status(500).json({ message: "Could not load books." });
      }
    }
  );

  app.get("/books/:id", verifyToken, async (req, res) => {
    const { id } = req.params;

    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid book ID." });
    }

    try {
      const book = await booksCollection.findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            ...listFields,
            description: 1,
            "addedBy.name": 1,
          },
        }
      );

      if (!book) {
        return res.status(404).json({ message: "Book not found." });
      }

      return res.json(book);
    } catch (error) {
      console.error("Failed to load book:", error.message);
      return res.status(500).json({ message: "Could not load this book." });
    }
  });

  app.post("/books", verifyToken, async (req, res) => {
    const { book, error } = readBookFields(req.body, ["i.ibb.co"]);

    if (error) {
      return res.status(400).json({ message: error });
    }

    try {
      const result = await booksCollection.insertOne({
        ...book,
        availableCopies: book.totalCopies,
        ownerId: req.user.id,
        addedBy: {
          name: req.user.name,
          email: req.user.email,
        },
        createdAt: new Date(),
      });

      return res.status(201).json({
        message: "Book added successfully.",
        insertedId: result.insertedId,
      });
    } catch (error) {
      console.error("Failed to save book:", error.message);
      return res.status(500).json({ message: "Could not save the book." });
    }
  });

  app.patch("/books/:id", verifyToken, async (req, res) => {
    const { id } = req.params;

    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid book ID." });
    }

    const { book, error } = readBookFields(req.body, [
      "i.ibb.co",
      "covers.openlibrary.org",
    ]);

    if (error) {
      return res.status(400).json({ message: error });
    }

    const ownerFilter = {
      _id: new ObjectId(id),
      ownerId: req.user.id,
    };

    const copiesOnLoan = {
      $subtract: ["$totalCopies", "$availableCopies"],
    };

    try {
      const result = await booksCollection.updateOne(
        {
          ...ownerFilter,
          $expr: { $lte: [copiesOnLoan, book.totalCopies] },
        },
        [
          {
            $set: {
              title: { $literal: book.title },
              author: { $literal: book.author },
              category: { $literal: book.category },
              description: { $literal: book.description },
              image: { $literal: book.image },
              totalCopies: book.totalCopies,
              availableCopies: {
                $subtract: [book.totalCopies, copiesOnLoan],
              },
              updatedAt: "$$NOW",
            },
          },
        ]
      );

      if (result.matchedCount) {
        return res.json({ message: "Book updated successfully." });
      }

      const ownedBook = await booksCollection.findOne(ownerFilter);

      if (!ownedBook) {
        return res.status(404).json({ message: "Your book was not found." });
      }

      return res.status(409).json({
        message: "Total copies cannot be lower than the number on loan.",
      });
    } catch (error) {
      console.error("Failed to update book:", error.message);
      return res.status(500).json({ message: "Could not update the book." });
    }
  });

  app.delete("/books/:id", verifyToken, async (req, res) => {
    const { id } = req.params;

    if (!/^[a-f0-9]{24}$/i.test(id)) {
      return res.status(400).json({ message: "Invalid book ID." });
    }

    const ownerFilter = {
      _id: new ObjectId(id),
      ownerId: req.user.id,
    };

    try {
      const result = await booksCollection.deleteOne({
        ...ownerFilter,
        $expr: { $eq: ["$availableCopies", "$totalCopies"] },
      });

      if (result.deletedCount) {
        return res.sendStatus(204);
      }

      const ownedBook = await booksCollection.findOne(ownerFilter);

      if (!ownedBook) {
        return res.status(404).json({ message: "Your book was not found." });
      }

      return res.status(409).json({
        message: "Return all borrowed copies before deleting this book.",
      });
    } catch (error) {
      console.error("Failed to delete book:", error.message);
      return res.status(500).json({ message: "Could not delete the book." });
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