import { getConfigStatus } from "../utils/rag";

export default defineEventHandler(() => ({
  ok: true,
  configured: getConfigStatus()
}));
