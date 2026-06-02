import { handleChat } from "../utils/rag";

export default defineEventHandler(async (event) => {
  const result = await handleChat(event);

  if ("statusCode" in result) {
    setResponseStatus(event, result.statusCode);
    return { error: result.error };
  }

  return result;
});
