import { handleChat, toPublicErrorMessage } from "../utils/rag";

export default defineEventHandler(async (event) => {
  try {
    const result = await handleChat(event);

    if ("statusCode" in result) {
      setResponseStatus(event, result.statusCode);
      return { error: result.error };
    }

    return result;
  } catch (error) {
    console.error(error);
    setResponseStatus(event, 500);
    return { error: toPublicErrorMessage(error) };
  }
});
