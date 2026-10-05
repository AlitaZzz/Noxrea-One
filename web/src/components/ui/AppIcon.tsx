/**
 * Project icon boundary.
 *
 * Business code imports icon components from this module only. The concrete
 * source can be custom SVG, Lucide, or another icon implementation without
 * leaking that choice into feature code.
 */
"use client";

import {
  ArrowLeft as LucideArrowLeft,
  ArrowLeftRight as LucideArrowLeftRight,
  ArrowUp as LucideArrowUp,
  Bold as LucideBold,
  Bot as LucideBot,
  Camera as LucideCamera,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  CircleAlert as LucideCircleAlert,
  CirclePause as LucideCirclePause,
  CirclePlay as LucideCirclePlay,
  Clipboard as LucideClipboard,
  Clock3 as LucideClock3,
  Copy as LucideCopy,
  Crop as LucideCrop,
  Crown as LucideCrown,
  Download as LucideDownload,
  FlipHorizontal as LucideFlipHorizontal,
  FlipVertical as LucideFlipVertical,
  Folder as LucideFolder,
  FolderOpen as LucideFolderOpen,
  FolderPlus as LucideFolderPlus,
  Grid2X2 as LucideGrid2X2,
  Heading1 as LucideHeading1,
  Heading2 as LucideHeading2,
  Heading3 as LucideHeading3,
  Image as LucideImage,
  Info as LucideInfo,
  Italic as LucideItalic,
  List as LucideList,
  ListOrdered as LucideListOrdered,
  LoaderCircle,
  Lock as LucideLock,
  Maximize as LucideMaximize,
  Minus as LucideMinus,
  MoreHorizontal as LucideMoreHorizontal,
  MousePointer2 as LucideMousePointer2,
  Pause as LucidePause,
  Pencil as LucidePencil,
  Plus as LucidePlus,
  Quote as LucideQuote,
  Redo2 as LucideRedo2,
  RefreshCw as LucideRefreshCw,
  RotateCw as LucideRotateCw,
  Scissors as LucideScissors,
  Search as LucideSearch,
  Square as LucideSquare,
  SquareDashed as LucideSquareDashed,
  SquarePlus as LucideSquarePlus,
  Star as LucideStar,
  StepBack as LucideStepBack,
  StepForward as LucideStepForward,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Type as LucideType,
  Undo2 as LucideUndo2,
  Upload as LucideUpload,
  User as LucideUser,
  Video as LucideVideo,
  Wand2 as LucideWand2,
  Waypoints as LucideWaypoints,
  X as LucideX,
  ZoomIn as LucideZoomIn,
  ZoomOut as LucideZoomOut,
} from "lucide-react";
import type { ComponentProps, ComponentType } from "react";

export * from './icons/agent/ArrangeIcon';
export * from './icons/agent/CanvasStateIcon';
export * from './icons/agent/ConnectNodesIcon';
export * from './icons/agent/CreateNodeIcon';
export * from './icons/agent/DeleteNodeIcon';
export * from './icons/agent/DuplicateIcon';
export * from './icons/agent/HistoryIcon';
export * from './icons/agent/MoveIcon';
export * from './icons/agent/NewChatIcon';
export * from './icons/agent/NodeDetailIcon';
export * from './icons/agent/SelectIcon';
export * from './icons/agent/UndoTurnIcon';
export * from './icons/agent/UnlinkIcon';
export * from './icons/agent/UpdateNodeIcon';
export * from './icons/agent/ViewportFocusIcon';
export * from './icons/canvas/AgentIcon';
export * from './icons/canvas/AspectRatioIcon';
export * from './icons/canvas/AssetsIcon';
export * from './icons/canvas/Back5sIcon';
export * from './icons/canvas/BrushSizeIcon';
export * from './icons/canvas/CharacterFaceThreeViewIcon';
export * from './icons/canvas/CharacterThreeViewIcon';
export * from './icons/canvas/ClipTrimIcon';
export * from './icons/canvas/Forward3sIcon';
export * from './icons/canvas/Grid4Icon';
export * from './icons/canvas/Grid8Icon';
export * from './icons/canvas/Grid12Icon';
export * from './icons/canvas/GridLayoutIcon';
export * from './icons/canvas/GridSplitIcon';
export * from './icons/canvas/GroupGridIcon';
export * from './icons/canvas/GroupIcon';
export * from './icons/canvas/HorizontalLayoutIcon';
export * from './icons/canvas/ImageAnnotationIcon';
export * from './icons/canvas/ImageToPromptIcon';
export * from './icons/canvas/LightCorrectionIcon';
export * from './icons/canvas/LightingIcon';
export * from './icons/canvas/MagnetIcon';
export * from './icons/canvas/MapPinIcon';
export * from './icons/canvas/MultiAngleIcon';
export * from './icons/canvas/NineGridIcon';
export * from './icons/canvas/PanelIcon';
export * from './icons/canvas/PanoramaIcon';
export * from './icons/canvas/ParamsIcon';
export * from './icons/canvas/PresetIcon';
export * from './icons/canvas/ProductThreeViewIcon';
export * from './icons/canvas/RatioIcon';
export * from './icons/canvas/RedoIcon';
export * from './icons/canvas/ResetIcon';
export * from './icons/canvas/ResizeCornerIcon';
export * from './icons/canvas/SendToCanvasIcon';
export * from './icons/canvas/ShortcutIcon';
export * from './icons/canvas/SmartEditBrushToolIcon';
export * from './icons/canvas/SpeedIcon';
export * from './icons/canvas/Storyboard4Icon';
export * from './icons/canvas/Storyboard25Icon';
export * from './icons/canvas/SunIcon';
export * from './icons/canvas/ThermometerIcon';
export * from './icons/canvas/TrashIcon';
export * from './icons/canvas/UndoIcon';
export * from './icons/canvas/UngroupIcon';
export * from './icons/canvas/VerticalLayoutIcon';
export * from './icons/canvas/VideoToPromptIcon';
export * from './icons/canvas/ZoomIcon';
export * from './icons/common/ChevronDownIcon';
export * from './icons/common/EyeIcon';
export * from './icons/common/EyeOffIcon';
export * from './icons/common/FilterIcon';
export * from './icons/common/ManageIcon';
export * from './icons/common/SpinnerIcon';
export * from './icons/director/DirCameraIcon';
export * from './icons/director/DirCaretIcon';
export * from './icons/director/DirCubeIcon';
export * from './icons/director/DirExpandIcon';
export * from './icons/director/DirEyeIcon';
export * from './icons/director/DirEyeOffIcon';
export * from './icons/director/DirFrameIcon';
export * from './icons/director/DirGroupIcon';
export * from './icons/director/DirImageIcon';
export * from './icons/director/DirMoveIcon';
export * from './icons/director/DirPersonIcon';
export * from './icons/director/DirPointerIcon';
export * from './icons/director/DirRotateIcon';
export * from './icons/director/DirScaleIcon';
export * from './icons/director/DirSendIcon';
export * from './icons/director/DirShotIcon';
export * from './icons/director/DirTrashIcon';
export * from './icons/director/DirUploadIcon';
export * from './icons/director/DirVideoIcon';
export * from './icons/director/NavSvg';
export * from './icons/media/FrameCaptureIcon';
export * from './icons/media/PauseIcon';
export * from './icons/media/PlayIcon';
export * from './icons/media/StopIcon';
export * from './icons/media/TextIcon';
export * from './icons/media/TextToVideoIcon';
export * from './icons/media/VideoCameraIcon';
export * from './icons/media/VideoFrameIcon';
export * from './icons/media/VideoRefIcon';
export * from './icons/media/VolumeMuteIcon';
export * from './icons/media/VolumeUpIcon';
export * from './icons/media/WaveIcon';
export * from './icons/models/AgnesIcon';
export * from './icons/models/ClaudeIcon';
export * from './icons/models/DeepSeekIcon';
export * from './icons/models/DoubaoIcon';
export * from './icons/models/FluxIcon';
export * from './icons/models/GeminiIcon';
export * from './icons/models/GLMIcon';
export * from './icons/models/GrokIcon';
export * from './icons/models/HappyHorseIcon';
export * from './icons/models/KimiIcon';
export * from './icons/models/KlingIcon';
export * from './icons/models/MiniMaxIcon';
export * from './icons/models/OpenAIIcon';
export * from './icons/models/QwenIcon';
export * from './icons/models/SeedanceIcon';
export * from './icons/models/SunoIcon';
export * from './icons/models/ViduIcon';
export * from './icons/theme/ThemeModeIcon';

// Generic icons are adapted to the project's 1em sizing contract. This keeps
// existing font-size/className usage stable while hiding Lucide's API.
type IconProps = ComponentProps<typeof LoaderCircle>;
type IconComponent = ComponentType<IconProps>;

function adaptIcon(Icon: IconComponent) {
  return function ProjectIcon({ size = "1em", ...props }: IconProps) {
    return <Icon {...props} size={size} />;
  };
}

const ApiOutlined = adaptIcon(LucideWaypoints);
const AppstoreOutlined = adaptIcon(LucideGrid2X2);
const ArrowLeftOutlined = adaptIcon(LucideArrowLeft);
const ArrowUpOutlined = adaptIcon(LucideArrowUp);
const BorderInnerOutlined = adaptIcon(LucideSquareDashed);
const BorderOutlined = adaptIcon(LucideSquare);
const CameraOutlined = adaptIcon(LucideCamera);
const CaretDownOutlined = adaptIcon(LucideChevronDown);
const CaretRightOutlined = adaptIcon(LucideChevronRight);
const CaretUpOutlined = adaptIcon(LucideChevronUp);
const CheckOutlined = adaptIcon(LucideCheck);
const ClockCircleOutlined = adaptIcon(LucideClock3);
const CloseOutlined = adaptIcon(LucideX);
const CopyOutlined = adaptIcon(LucideCopy);
const CrownOutlined = adaptIcon(LucideCrown);
const DeleteOutlined = adaptIcon(LucideTrash2);
const DownloadOutlined = adaptIcon(LucideDownload);
const DownOutlined = adaptIcon(LucideChevronDown);
const EditOutlined = adaptIcon(LucidePencil);
const EllipsisOutlined = adaptIcon(LucideMoreHorizontal);
const ExclamationCircleOutlined = adaptIcon(LucideCircleAlert);
const ExpandOutlined = adaptIcon(LucideMaximize);
const FolderAddOutlined = adaptIcon(LucideFolderPlus);
const FolderOpenOutlined = adaptIcon(LucideFolderOpen);
const FolderOutlined = adaptIcon(LucideFolder);
const FontSizeOutlined = adaptIcon(LucideType);
const FullscreenOutlined = adaptIcon(LucideMaximize);
const InfoCircleOutlined = adaptIcon(LucideInfo);
const LeftOutlined = adaptIcon(LucideChevronLeft);
const LockOutlined = adaptIcon(LucideLock);
const MinusOutlined = adaptIcon(LucideMinus);
const PartitionOutlined = adaptIcon(LucideWaypoints);
const PauseCircleFilled = adaptIcon(LucideCirclePause);
const PauseOutlined = adaptIcon(LucidePause);
const PictureOutlined = adaptIcon(LucideImage);
const PlayCircleFilled = adaptIcon(LucideCirclePlay);
const PlayCircleOutlined = adaptIcon(LucideCirclePlay);
const PlusOutlined = adaptIcon(LucidePlus);
const PlusSquareOutlined = adaptIcon(LucideSquarePlus);
const RedoOutlined = adaptIcon(LucideRedo2);
const ReloadOutlined = adaptIcon(LucideRefreshCw);
const RightOutlined = adaptIcon(LucideChevronRight);
const RobotOutlined = adaptIcon(LucideBot);
const RotateRightOutlined = adaptIcon(LucideRotateCw);
const ScissorOutlined = adaptIcon(LucideScissors);
const SearchOutlined = adaptIcon(LucideSearch);
const SelectOutlined = adaptIcon(LucideMousePointer2);
const SnippetsOutlined = adaptIcon(LucideClipboard);
const StarFilled = adaptIcon(LucideStar);
const StarOutlined = adaptIcon(LucideStar);
const StepBackwardOutlined = adaptIcon(LucideStepBack);
const StepForwardOutlined = adaptIcon(LucideStepForward);
const SwapOutlined = adaptIcon(LucideArrowLeftRight);
const UndoOutlined = adaptIcon(LucideUndo2);
const UploadOutlined = adaptIcon(LucideUpload);
const UserOutlined = adaptIcon(LucideUser);
const VideoCameraOutlined = adaptIcon(LucideVideo);
const WarningOutlined = adaptIcon(LucideTriangleAlert);
const ZoomInOutlined = adaptIcon(LucideZoomIn);
const ZoomOutOutlined = adaptIcon(LucideZoomOut);
const Bold = adaptIcon(LucideBold);
const Copy = adaptIcon(LucideCopy);
const Crop = adaptIcon(LucideCrop);
const FlipHorizontal = adaptIcon(LucideFlipHorizontal);
const FlipVertical = adaptIcon(LucideFlipVertical);
const Heading1 = adaptIcon(LucideHeading1);
const Heading2 = adaptIcon(LucideHeading2);
const Heading3 = adaptIcon(LucideHeading3);
const Italic = adaptIcon(LucideItalic);
const List = adaptIcon(LucideList);
const ListOrdered = adaptIcon(LucideListOrdered);
const Minus = adaptIcon(LucideMinus);
const Quote = adaptIcon(LucideQuote);
const Type = adaptIcon(LucideType);
const Wand2 = adaptIcon(LucideWand2);

export {
  ApiOutlined, AppstoreOutlined, ArrowLeftOutlined, ArrowUpOutlined, Bold,
  BorderInnerOutlined, BorderOutlined, CameraOutlined, CaretDownOutlined, CaretRightOutlined,
  CaretUpOutlined, CheckOutlined, ClockCircleOutlined, CloseOutlined, Copy, CopyOutlined, Crop, CrownOutlined,
  DeleteOutlined, DownloadOutlined, DownOutlined, EditOutlined, EllipsisOutlined,
  ExclamationCircleOutlined, ExpandOutlined, FlipHorizontal, FlipVertical, FolderAddOutlined,
  FolderOpenOutlined, FolderOutlined, FontSizeOutlined, FullscreenOutlined, Heading1, Heading2,
  Heading3, InfoCircleOutlined, Italic, LeftOutlined, List, ListOrdered, LockOutlined, Minus,
  MinusOutlined, PartitionOutlined, PauseCircleFilled, PauseOutlined, PictureOutlined,
  PlayCircleFilled, PlayCircleOutlined, PlusOutlined, PlusSquareOutlined, Quote, RedoOutlined,
  ReloadOutlined, RightOutlined, RobotOutlined, RotateRightOutlined, ScissorOutlined,
  SearchOutlined, SelectOutlined, SnippetsOutlined, StarFilled, StarOutlined, StepBackwardOutlined,
  StepForwardOutlined, SwapOutlined, Type, UndoOutlined, UploadOutlined, UserOutlined,
  VideoCameraOutlined, Wand2, WarningOutlined, ZoomInOutlined, ZoomOutOutlined,
};

export function LoadingOutlined({
  spin,
  className,
  size = "1em",
  ...props
}: ComponentProps<typeof LoaderCircle> & { spin?: boolean }) {
  const classes = [spin ? "animate-spin" : "", className].filter(Boolean).join(" ");
  return <LoaderCircle {...props} size={size} className={classes || undefined} />;
}
