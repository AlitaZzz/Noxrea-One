/**
 * 画布加载动画：四叶草转圈。
 * 四片青柠叶瓣绕中心依次呼吸并整体旋转，置于石墨底上。
 */
export default function CanvasLoader() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "var(--canvas-app-bg)" }}>
      <div className="canvas-clover">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="canvas-clover-petal"
            style={{ transform: `rotate(${i * 90}deg) translateY(-15px)`, animationDelay: `${i * 0.2}s` }}
          />
        ))}
      </div>
    </div>
  );
}
