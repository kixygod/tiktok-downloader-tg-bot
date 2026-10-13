import { shouldFallbackToDocument } from "./reliability";

export async function sendWithDocumentFallback(
  sendPhoto: () => Promise<unknown>,
  sendDocument: () => Promise<unknown>,
): Promise<"photo" | "document"> {
  try {
    await sendPhoto();
    return "photo";
  } catch (error) {
    if (!shouldFallbackToDocument(error)) throw error;
    await sendDocument();
    return "document";
  }
}
