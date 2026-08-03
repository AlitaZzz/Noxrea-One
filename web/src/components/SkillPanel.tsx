"use client";

import { ThunderboltOutlined } from "@ant-design/icons";
import { Popover, Spin, Empty, Tooltip } from "antd";
import { useCallback, useEffect, useState } from "react";

interface SkillMeta {
  name: string;
  title: string;
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
      const res = await fetch("/api/chat/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SkillMeta[];
      setSkills(Array.isArray(data) ? data : []);
    } catch {
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && skills.length === 0) load();
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
                padding: "6px 8px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "background .15s",
              }}
              className="skill-item"
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</div>
              {s.description && (
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  {s.description}
                </div>
              )}
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
