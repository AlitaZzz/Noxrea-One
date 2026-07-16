import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const { baseUrl, apiKey, prompt, model, imageBase64 } = await request.json();

    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    // OpenAI-compatible: POST with multipart or JSON body (varies by provider)
    // Try multipart first (standard), fall back to JSON
    const formData = new FormData();
    formData.append("prompt", prompt || "");
    formData.append("model", model);
    formData.append("n", "1");
    formData.append("size", "1024x1024");

    // Convert base64 to blob for multipart
    if (imageBase64) {
      const byteString = atob(imageBase64.split(",")[1] || imageBase64);
      const mimeType = imageBase64.split(";")[0]?.replace("data:", "") || "image/png";
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
      formData.append("image", new Blob([ab], { type: mimeType }), "image.png");
    }

    const res = await fetch(`${baseUrl}/images/edits`, {
      method: "POST",
      headers: { ...headers },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: `HTTP ${res.status}: ${err}` }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
