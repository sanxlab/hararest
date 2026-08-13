import { Request, Response, NextFunction } from "express";
import { NsfwService } from "./nsfw.service";
import { AppError } from "../../utils/AppError";

const nsfwService = new NsfwService();

export const rule34Handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tags, limit, api_key, user_id } = req.query;
    if (!tags || typeof tags !== "string") {
      return next(new AppError("Query parameter \"tags\" is required.", 400));
    }
    const limitNum = limit ? parseInt(limit as string, 10) : 10;
    const data = await nsfwService.getRule34(tags as string, limitNum, api_key as string, user_id as string);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

export const danbooruHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tags, limit } = req.query;
    if (!tags || typeof tags !== "string") {
      return next(new AppError("Query parameter \"tags\" is required.", 400));
    }
    const limitNum = limit ? parseInt(limit as string, 10) : 10;
    const data = await nsfwService.getDanbooru(tags as string, limitNum);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

export const waifuimHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tag, nsfw } = req.query;
    if (!tag || typeof tag !== "string") {
      return next(new AppError("Query parameter \"tag\" is required.", 400));
    }
    const isNsfw = nsfw !== "false";
    const data = await nsfwService.getWaifuIm(tag as string, isNsfw);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

export const nhentaiGalleryHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    if (!id) {
      return next(new AppError("Path parameter \"id\" is required.", 400));
    }
    const data = await nsfwService.getNhentaiGallery(id as string);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

export const nhentaiSearchHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { query } = req.query;
    if (!query || typeof query !== "string") {
      return next(new AppError("Query parameter \"query\" is required.", 400));
    }
    const data = await nsfwService.searchNhentai(query as string);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

export const purrbotHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { category } = req.params;
    if (!category) {
      return next(new AppError("Path parameter \"category\" is required.", 400));
    }
    const data = await nsfwService.getPurrbot(category as string);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};
