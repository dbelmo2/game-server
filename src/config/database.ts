import mongoose from "mongoose";
import logger from "../utils/logger";
import { config } from "./config";

export default async () => {
    try {
        logger.info(`Connecting to MongoDB using URI "${config.MONGO_URI}"`);
        logger.info(`process.env.MONGO_URI ${process.env.MONGO_URI}`);
        console.log(`process.env.NODE_ENV ${process.env.NODE_ENV}`);

        await mongoose.connect(config.MONGO_URI as string);
        logger.info("MongoDB connected successfully");
    }   catch (error) {
        logger.error("MongoDB connection error:", error);
    }

}