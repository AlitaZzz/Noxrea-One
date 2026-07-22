"use client";

import { memo, useState } from "react";
import { Select, Input, App, Button } from "antd";
import { ThunderboltOutlined } from "@ant-design/icons";
import { useModelStore } from "@/stores/model-store";
import { getTokenHeader, BASE } from "@/lib/api";
import { EventNames } from "@/lib/eventNames";
import WheelGuard from "@/components/common/WheelGuard";

interface Props { nodeId: string; currentContent: string; }

const TextAskPanel = memo(function TextAskPanel({ nodeId, currentContent }: Props) {
  const channels = useModelStore((s) => s.channels);
  const allModels = channels.flatMap((c) => c.models.filter((m) => m.capabilities?.includes("text")).map((m) => ({ value: `${c.name}/${m.name}`, channelId: c.id, modelName: m.name })));
  const { message } = App.useApp();

  const [prompt, setPrompt] = useState("");
  const [modelKey, setModelKey] = useState(allModels[0]?.value || "");
  const [loading, setLoading] = useState(false);

  const handleAsk = async () => {
    if (!prompt.trim() || !modelKey) return;
    const entry = allModels.find((m) => m.value === modelKey);
    if (!entry) return;
    const channel = channels.find((c) => c.id === entry.channelId);
    if (!channel) return;

    setLoading(true);
    try {
      const msgs = [];
      if (currentContent) msgs.push({ role: "user", content: currentContent });
      msgs.push({ role: "user", content: prompt.trim() });

      const res = await fetch(`${BASE}/api/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", ...getTokenHeader() },
        body: JSON.stringify({ channelId: entry.channelId, model: entry.modelName, messages: msgs }),
      });
      const json = await res.json();
      if (json.code !== 200) throw new Error(json.msg || `HTTP ${res.status}`);

      const reply = json.data?.choices?.[0]?.message?.content || "";
      const newContent = currentContent ? `${currentContent}\n\nQ: ${prompt.trim()}\nA: ${reply}` : reply;
      window.dispatchEvent(new CustomEvent(EventNames.NODE_UPDATE_DATA, {
        detail: { nodeId, data: { content: newContent } },
      }));
      setPrompt("");
      message.success("Done!");
    } catch (err: any) {
      message.error(err.message || "Failed");
    }
    setLoading(false);
  };

  const is: React.CSSProperties = { background: "var(--canvas-bg-elevated)", border: "1px solid var(--canvas-border-light)", color: "var(--canvas-text)", borderRadius: 4, fontSize: 12 };

  return (
    <WheelGuard className="nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl" style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)", width: 380 }}>
      <Input.TextArea size="small" placeholder="Ask AI about this content..." value={prompt} onChange={(e) => setPrompt(e.target.value)}
        autoSize={{ minRows: 1, maxRows: 3 }}
        style={{ ...is, resize: "vertical" }} />
      <div className="flex items-center gap-2">
        <Select size="small" value={modelKey || undefined} onChange={setModelKey} style={{ flex: 1 }}
          options={allModels.map((m) => ({ label: m.value, value: m.value }))} />
        <Button type="primary" size="small" className="flex items-center gap-1 text-xs font-medium flex-shrink-0"
          style={{ height: 30 }} loading={loading} disabled={!prompt.trim() || !modelKey}
          onClick={handleAsk} icon={<ThunderboltOutlined />}>
          {loading ? "..." : "Ask AI"}
        </Button>
      </div>
    </WheelGuard>
  );
});

export default TextAskPanel;
