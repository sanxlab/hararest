import { Router } from "express";
import {
  rule34Handler,
  danbooruHandler,
  waifuimHandler,
  nhentaiGalleryHandler,
  nhentaiSearchHandler,
  purrbotHandler,
  nhentaiPdfHandler
} from "./nsfw.controller";

const router = Router();

router.get("/rule34", rule34Handler);
router.get("/danbooru", danbooruHandler);
router.get("/waifu", waifuimHandler);
router.get("/nhentai/gallery/:id", nhentaiGalleryHandler);
router.get("/nhentai/search", nhentaiSearchHandler);
router.get("/nhentai/pdf/:id", nhentaiPdfHandler);
router.get("/purrbot/:category", purrbotHandler);

export default router;
