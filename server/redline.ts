import { REDLINE_SYSTEM_PROMPT } from "./redline-prompt";
import { storage } from "./storage";

import { cfg } from "./config";
function getApiKey() { return cfg("ANTHROPIC_API_KEY"); }
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
export const REDLINE_VERSION = "2.0";

export async function processRedlineJob(jobId: number, articleText: string) {
  const apiKey = getApiKey();
  if (!apiKey) {
    storage.updateRedlineJob(jobId, "error");
    console.error("[redline] No ANTHROPIC_API_KEY configured");
    return;
  }

  try {
    console.log(`[redline] Processing job ${jobId} (${articleText.length} chars) with ${MODEL}...`);

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        temperature: 0.3,
        system: REDLINE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Please sub-edit the following article for StereoNET publication. Apply all house style rules, editorial conventions, and scoring (if it's a review).\n\n---\n\n${articleText}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[redline] API error ${response.status}: ${errText}`);
      storage.updateRedlineJob(jobId, "error");
      return;
    }

    const data = await response.json();
    const fullOutput = data.content?.[0]?.text || "";

    // Split the output into edited article and changes summary
    const changesSplit = fullOutput.indexOf("## Changes Made");
    let editedText = fullOutput;
    let changesSummary = "";

    if (changesSplit > -1) {
      editedText = fullOutput.substring(0, changesSplit).trim();
      changesSummary = fullOutput.substring(changesSplit + "## Changes Made".length).trim();
    }

    storage.updateRedlineJob(jobId, "completed", editedText, changesSummary);
    console.log(`[redline] Job ${jobId} completed. Output: ${editedText.length} chars`);
  } catch (err: any) {
    console.error(`[redline] Job ${jobId} failed:`, err?.message);
    storage.updateRedlineJob(jobId, "error");
  }
}
