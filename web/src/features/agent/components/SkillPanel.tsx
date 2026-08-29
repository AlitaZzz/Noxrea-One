/**
 * 对话技能选择面板。
 * 从后端拉取可用技能列表并以气泡形式分类展示，选中后把 /技能名 追加到输入框。
 */
"use client";

import { ThunderboltOutlined } from "@ant-design/icons";
import { Empty, Popover, Spin, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

import { agentApi } from "@/features/agent/api";
import { resolveResponseError } from "@/lib/api/error-message";

interface SkillMeta {
  name: string;
  displayTitle: string;
  description: string;
  category: string;
  appliesTo?: string[];
}

interface Props {
  /** 选中技能后，把 /name 追加到输入框 */
  onSelect: (skillName: string) => void;
}

/** 从 /api/chat/skills 拉取技能列表，Popover 展示，点击追加 /name 到输入框 */
export default function SkillPanel({ onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [skills, setSkills] = useState<SkillMeta[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await agentApi.listSkills();
      if (!res.ok) throw new Error(await resolveResponseError(res, "agent.request_failed"));
      const data = (await res.json()) as SkillMeta[];
      setSkills(Array.isArray(data) ? data : []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && skills.length === 0) queueMicrotask(load);
  }, [open, skills.length, load]);

  const content = (
    <div style={{ maxWidth: 280, maxHeight: 320, overflowY: "auto" }}>
      {loading ? (
        <div style={{ padding: 16, textAlign: "center" }}>
          <Spin size="small" />
        </div>
      ) : skills.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无技能" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {skills.map((s) => (
            <div
              key={s.name}
              onClick={() => {
                onSelect(s.name);
                setOpen(false);
              }}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                padding: "8px 10px",
                borderRadius: 8,
                cursor: "pointer",
                transition: "background .15s",
              }}
              className="skill-item"
            >
              <ThunderboltOutlined
                style={{ fontSize: 16, marginTop: 2, color: "var(--canvas-accent)", flexShrink: 0 }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    color: "var(--canvas-text)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {s.displayTitle}
                </div>
                {s.description && (
                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.65,
                      marginTop: 2,
                      color: "var(--canvas-text-dim)",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {s.description}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="topLeft"
        title="技能"
        content={content}
      >
        <Tooltip title="技能" placement="top">
          <button type="button" className="chat-composer-icon chat-skill-btn" aria-label="技能">
            <ThunderboltOutlined />
          </button>
        </Tooltip>
      </Popover>
    </>
  );
}
