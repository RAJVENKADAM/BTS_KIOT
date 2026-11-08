const mongoose = require("mongoose");

const loginAttemptBucketSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    attempts: {
      type: [
        {
          reservationId: { type: String, required: true },
          createdAt: { type: Date, required: true },
          state: {
            type: String,
            enum: ["pending", "failed"],
            required: true,
          },
        },
      ],
      required: true,
      default: [],
    },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: "loginattemptbuckets",
    versionKey: false,
    autoIndex: false,
  },
);

module.exports = mongoose.model(
  "LoginAttemptBucket",
  loginAttemptBucketSchema,
  "loginattemptbuckets",
);
