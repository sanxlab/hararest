import { queryInteger } from '../../utils/query';
import { Request, Response, NextFunction } from "express";
import { NsfwService } from "./nsfw.service";
import { AppError } from "../../utils/AppError";
import { generateNhentaiPdf } from "./nhentai-pdf.service";

const nsfwService = new NsfwService();

export const danbooruHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tags, limit } = req.query;
    if (!tags || typeof tags !== "string") {
      return next(new AppError("Query parameter \"tags\" is required.", 400));
    }
    const limitNum = queryInteger(limit, 'limit', 10, 200);
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
    if (nsfw !== undefined && nsfw !== "true" && nsfw !== "false") {
      return next(new AppError('Parameter "nsfw" must be true or false.', 400));
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
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) {
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
    if (typeof category !== "string" || !/^[a-z][a-z0-9_-]*$/i.test(category)) {
      return next(new AppError("Path parameter \"category\" is required.", 400));
    }
    const data = await nsfwService.getPurrbot(category as string);
    res.status(200).json({ status: "success", data });
  } catch (error) {
    next(error);
  }
};

export const nhentaiPdfHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { id } = req.params;
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id)) {
      return next(new AppError("Path parameter \"id\" harus berupa angka positif.", 400));
    }
    const { pdf, title, pageCount } = await generateNhentaiPdf(id);
    const safeTitle = title.replace(/[^\w\s.-]/g, '').trim().slice(0, 100) || `nhentai-${id}`;
    const filename = `${safeTitle}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', pdf.length);
    res.setHeader('X-Page-Count', pageCount);
    res.status(200).end(pdf);
  } catch (error) {
    next(error);
  }
};
