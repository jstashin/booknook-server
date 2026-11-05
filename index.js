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

function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

function objectId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) {
    throw apiError(400, "Invalid ID.");
  }

  return new ObjectId(value);
}

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

function readBookFields(body, coverHosts) {
  const { title, author, category, description, image, totalCopies } =
    body || {};

  const validText = (value, maxLength) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength;

  if (
    !validText(title, 150) ||
    !validText(author, 100) ||
    !validText(description, 2000) ||
    !categories.includes(category) ||
    !Number.isInteger(totalCopies) ||
    totalCopies < 1 ||
    totalCopies > 10000
  ) {
    throw apiError(400, "Check the book details and total copies.");
  }

  let cover;

  try {
    cover = new URL(image);
  } catch {
    throw apiError(400, "Invalid cover URL.");
  }

  if (cover.protocol !== "https:" || !coverHosts.includes(cover.hostname)) {
    throw apiError(400, "Use a supported book cover URL.");
  }

  return {
    title: title.trim(),
    author: author.trim(),
    category,
    description: description.trim(),
    image: cover.href,
    totalCopies,
  };
}

async function startServer() {
  await client.connect();

  const db = client.db("booknook");
  const books = db.collection("books");
  const borrows = db.collection("borrows");

await Promise.all([
  books.createIndexes([
    { key: { createdAt: -1, _id: -1 } },
  ]),
  borrows.createIndexes([
    { key: { bookId: 1, userId: 1 }, unique: true },
    { key: { userId: 1, borrowDate: -1 } },
  ]),
]);

  app.get(
    "/books",
    (req, res, next) => {
      if (req.query.mine === "true") {
        return verifyToken(req, res, next);
      }

      return next();
    },
    async (req, res) => {
      const { mine, limit } = req.query;
      const ownBooks = mine === "true";
      const filter = ownBooks ? { ownerId: req.user.id } : {};
      const projection = ownBooks
        ? { ...listFields, description: 1 }
        : listFields;

      const cursor = books.find(filter, { projection }).sort({
        createdAt: -1,
        _id: -1,
      });

      if (limit !== undefined) {
        const parsedLimit = Number(limit);

        if (
          typeof limit !== "string" ||
          !Number.isInteger(parsedLimit) ||
          parsedLimit < 1 ||
          parsedLimit > 100
        ) {
          throw apiError(400, "Limit must be an integer between 1 and 100.");
        }

        cursor.limit(parsedLimit);
      }

      return res.json(await cursor.toArray());
    }
  );

  app.get("/books/:id", verifyToken, async (req, res) => {
    const book = await books.findOne(
      { _id: objectId(req.params.id) },
      {
        projection: {
          ...listFields,
          description: 1,
          "addedBy.name": 1,
        },
      }
    );

    if (!book) {
      throw apiError(404, "Book not found.");
    }

    return res.json(book);
  });

  app.post("/books", verifyToken, async (req, res) => {
    const book = readBookFields(req.body, ["i.ibb.co"]);

    const result = await books.insertOne({
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
  });

  app.patch("/books/:id", verifyToken, async (req, res) => {
    const ownerFilter = {
      _id: objectId(req.params.id),
      ownerId: req.user.id,
    };

    const book = readBookFields(req.body, [
      "i.ibb.co",
      "covers.openlibrary.org",
    ]);

    const copiesOnLoan = {
      $subtract: ["$totalCopies", "$availableCopies"],
    };

    const result = await books.updateOne(
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

    if (!(await books.findOne(ownerFilter))) {
      throw apiError(404, "Your book was not found.");
    }

    throw apiError(409, "Total copies cannot be lower than the number on loan.");
  });

  app.delete("/books/:id", verifyToken, async (req, res) => {
    const ownerFilter = {
      _id: objectId(req.params.id),
      ownerId: req.user.id,
    };

    const result = await books.deleteOne({
      ...ownerFilter,
      $expr: { $eq: ["$availableCopies", "$totalCopies"] },
    });

    if (result.deletedCount) {
      return res.sendStatus(204);
    }

    if (!(await books.findOne(ownerFilter))) {
      throw apiError(404, "Your book was not found.");
    }

    throw apiError(409, "Return all borrowed copies before deleting this book.");
  });

  app.post("/borrows", verifyToken, async (req, res) => {
    const bookId = objectId(req.body?.bookId);
    const userId = req.user.id;

    const result = await client.withSession((session) =>
      session.withTransaction(async () => {
        const existingLoan = await borrows.findOne(
          { bookId, userId },
          { session }
        );

        if (existingLoan) {
          throw apiError(409, "You already borrowed this book.");
        }

        const book = await books.findOneAndUpdate(
          { _id: bookId, availableCopies: { $gt: 0 } },
          { $inc: { availableCopies: -1 } },
          { session, returnDocument: "after" }
        );

        if (!book) {
          throw apiError(409, "This book is not available.");
        }

        const borrowDate = new Date();
        const returnDate = new Date(
          borrowDate.getTime() + 14 * 24 * 60 * 60 * 1000
        );

        return borrows.insertOne(
          {
            bookId,
            userId,
            email: req.user.email,
            title: book.title,
            image: book.image,
            borrowDate,
            returnDate,
          },
          { session }
        );
      })
    );

    return res.status(201).json({
      message: "Book borrowed successfully.",
      insertedId: result.insertedId,
    });
  });

  app.get("/borrows", verifyToken, async (req, res) => {
    const loans = await borrows
      .find({ userId: req.user.id })
      .sort({ borrowDate: -1 })
      .toArray();

    return res.json(loans);
  });

  app.delete("/borrows/:id", verifyToken, async (req, res) => {
    const loanId = objectId(req.params.id);

    await client.withSession((session) =>
      session.withTransaction(async () => {
        const loan = await borrows.findOneAndDelete(
          { _id: loanId, userId: req.user.id },
          { session }
        );

        if (!loan) {
          throw apiError(404, "Your loan was not found.");
        }

        const result = await books.updateOne(
          { _id: loan.bookId },
          { $inc: { availableCopies: 1 } },
          { session }
        );

        if (!result.matchedCount) {
          throw apiError(409, "The book record is missing.");
        }
      })
    );

    return res.sendStatus(204);
  });

  app.use((req, res) => {
    return res.status(404).json({ message: "API route not found." });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    if (error.code === 11000) {
      return res.status(409).json({ message: "You already borrowed this book." });
    }

    const status = error.status || 500;

    if (status >= 500) {
      console.error("BookNook API error:", error.message);
    }

    return res.status(status).json({
      message: status < 500 ? error.message : "Something went wrong. Try again.",
    });
  });

  app.listen(port, () => {
    console.log(`BookNook server is running on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});