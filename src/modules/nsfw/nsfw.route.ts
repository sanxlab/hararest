import { Router } from "express";
import {
  danbooruHandler,
  waifuimHandler,
  nhentaiGalleryHandler,
  nhentaiSearchHandler,
  purrbotHandler
} from "./nsfw.controller";

const router = Router();

router.get("/danbooru", danbooruHandler);
router.get("/waifu", waifuimHandler);
router.get("/nhentai/gallery/:id", nhentaiGalleryHandler);
router.get("/nhentai/search", nhentaiSearchHandler);
router.get("/purrbot/:category", purrbotHandler);

export default router;
