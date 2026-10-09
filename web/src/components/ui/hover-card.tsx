"use client"

import "./hover-card.css"

import { cn } from "cn"
import { HoverCard as HoverCardPrimitive } from "radix-ui"
import * as React from "react"
import { useTranslation } from "react-i18next"

import { ReloadOutlined } from "@/components/ui/AppIcon"
import { Button } from "@/components/ui/button"
import { useLayerZIndex } from "@/components/ui/modal/layer-context"

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardContentElement {...props} />
    </HoverCardPrimitive.Portal>
  )
}

function HoverCardContentElement({
  className,
  align = "center",
  sideOffset = 4,
  style,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  const layerZIndex = useLayerZIndex()

  return (
    <HoverCardPrimitive.Content
      data-slot="hover-card-content"
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "pointer-events-auto z-50 w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      style={{ ...style, ...(layerZIndex === undefined ? {} : { zIndex: layerZIndex }) }}
      {...props}
    />
  )
}

type HoverCardMediaContentProps = Omit<
  React.ComponentProps<typeof HoverCardPrimitive.Content>,
  "children" | "forceMount" | "asChild"
> & {
  mediaType: "image" | "video"
  src: string
  alt?: string
  mediaClassName?: string
}

function HoverCardMediaContent(props: HoverCardMediaContentProps) {
  return (
    <HoverCardPrimitive.Portal>
      <ReadyMediaContent key={`${props.mediaType}:${props.src}`} {...props} />
    </HoverCardPrimitive.Portal>
  )
}

function ReadyMediaContent({
  mediaType,
  src,
  alt = "",
  mediaClassName,
  style,
  ...props
}: HoverCardMediaContentProps) {
  const { t } = useTranslation()
  const [phase, setPhase] = React.useState<"loading" | "prepared" | "ready" | "error">("loading")
  const [retryCount, setRetryCount] = React.useState(0)
  const mediaRef = React.useRef<HTMLImageElement | HTMLVideoElement | null>(null)
  const decodeAttempt = React.useRef(0)

  const prepareImage = React.useCallback(async (image: HTMLImageElement) => {
    const attempt = ++decodeAttempt.current
    try {
      await image.decode()
      if (mediaRef.current === image && decodeAttempt.current === attempt) {
        setPhase((current) => current === "loading" ? "prepared" : current)
      }
    } catch {
      if (mediaRef.current === image && decodeAttempt.current === attempt) setPhase("error")
    }
  }, [])

  const prepareVideo = React.useCallback((video: HTMLVideoElement) => {
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      setPhase((current) => current === "loading" ? "prepared" : current)
    }
  }, [])

  const setMediaRef = React.useCallback((element: HTMLImageElement | HTMLVideoElement | null) => {
    mediaRef.current = element
    if (!element) return
    // Cached media may already be ready when its ref is attached.
    queueMicrotask(() => {
      if (mediaRef.current !== element) return
      if (element instanceof HTMLImageElement) {
        if (element.complete) void prepareImage(element)
      } else {
        prepareVideo(element)
      }
    })
  }, [prepareImage, prepareVideo])

  React.useEffect(() => {
    if (phase !== "prepared") return
    // Let intrinsic sizing and Radix's resize positioning settle before revealing the frame.
    let secondFrame: number | undefined
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setPhase("ready"))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
    }
  }, [phase])

  const onError = (element: HTMLImageElement | HTMLVideoElement) => {
    if (mediaRef.current !== element) return
    ++decodeAttempt.current
    setPhase("error")
  }

  const retry = () => {
    ++decodeAttempt.current
    setPhase("loading")
    setRetryCount((current) => current + 1)
  }

  return (
    <HoverCardContentElement
      {...props}
      data-media-preview=""
      data-media-state={phase}
      aria-busy={phase === "loading" || phase === "prepared"}
      style={{
        ...style,
        visibility: phase === "loading" || phase === "prepared" ? "hidden" : "visible",
        animation: phase === "ready" ? style?.animation : "none",
      }}
    >
      {mediaType === "image" ? (
        <img
          key={retryCount}
          ref={setMediaRef}
          src={src}
          alt={alt}
          draggable={false}
          className={cn(mediaClassName, phase === "error" && "hidden")}
          onLoad={(event) => { void prepareImage(event.currentTarget) }}
          onError={(event) => onError(event.currentTarget)}
        />
      ) : (
        <video
          key={retryCount}
          ref={setMediaRef}
          src={src}
          className={cn(mediaClassName, phase === "error" && "hidden")}
          autoPlay
          muted
          loop
          playsInline
          onLoadedData={(event) => prepareVideo(event.currentTarget)}
          onError={(event) => onError(event.currentTarget)}
        />
      )}
      {phase === "error" && (
        <div role="alert" className="flex min-w-48 flex-col items-center gap-2 px-4 py-5 text-center text-sm">
          <span>{t("media.previewLoadFailed")}</span>
          <Button type="button" size="sm" variant="secondary" onClick={retry}>
            <ReloadOutlined />
            {t("media.retry")}
          </Button>
        </div>
      )}
    </HoverCardContentElement>
  )
}

export { HoverCard, HoverCardContent, HoverCardMediaContent, HoverCardTrigger }
