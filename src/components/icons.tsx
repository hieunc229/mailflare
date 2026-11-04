import { createElement, forwardRef, type ComponentType, type SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
	ActivityIcon as HugeActivityIcon,
	AlertCircleIcon as HugeAlertCircleIcon,
	Archive03Icon as HugeArchiveIcon,
	ArchiveRestoreIcon as HugeArchiveRestoreIcon,
	ArrowDownIcon as HugeArrowDownIcon,
	ArrowDownToLineIcon as HugeArrowDownToLineIcon,
	ArrowLeftIcon as HugeArrowLeftIcon,
	ArrowRightIcon as HugeArrowRightIcon,
	ArrowUpIcon as HugeArrowUpIcon,
	AtSignIcon as HugeAtSignIcon,
	StarAward02Icon as HugeBadgeDollarSignIcon,
	BanIcon as HugeBanIcon,
	BellIcon as HugeBellIcon,
	BellOffIcon as HugeBellOffIcon,
	BellRingIcon as HugeBellRingIcon,
	BoldIcon as HugeBoldIcon,
	BotIcon as HugeBotIcon,
	Building02Icon as HugeBuilding02Icon,
	CalendarAdd02Icon as HugeCalendarAdd02Icon,
	CalendarClockIcon as HugeCalendarClockIcon,
	CalendarDaysIcon as HugeCalendarDaysIcon,
	CameraIcon as HugeCameraIcon,
	CancelCircleIcon as HugeCancelCircleIcon,
	CheckIcon as HugeCheckIcon,
	CheckmarkCircle02Icon as HugeCheckmarkCircle02Icon,
	CheckmarkSquare02Icon as HugeCheckmarkSquare02Icon,
	ChevronDownIcon as HugeChevronDownIcon,
	ChevronLeftIcon as HugeChevronLeftIcon,
	ChevronRightIcon as HugeChevronRightIcon,
	ChevronUpIcon as HugeChevronUpIcon,
	CircleXIcon as HugeCircleXIcon,
	Clock03Icon as HugeClock03Icon,
	ClockIcon as HugeClockIcon,
	CloudIcon as HugeCloudIcon,
	CloudUploadIcon as HugeCloudUploadIcon,
	CopyIcon as HugeCopyIcon,
	CornerDownLeftIcon as HugeCornerDownLeftIcon,
	CornerDownRightIcon as HugeCornerDownRightIcon,
	DatabaseBackupIcon as HugeDatabaseBackupIcon,
	DatabaseIcon as HugeDatabaseIcon,
	Delete02Icon as HugeDelete02Icon,
	DownloadIcon as HugeDownloadIcon,
	ExternalLinkIcon as HugeExternalLinkIcon,
	EyeIcon as HugeEyeIcon,
	EyeOffIcon as HugeEyeOffIcon,
	FileArchiveIcon as HugeFileArchiveIcon,
	FileAudioIcon as HugeFileAudioIcon,
	FileCodeCornerIcon as HugeFileCodeCornerIcon,
	FileCodeIcon as HugeFileCodeIcon,
	FileExclamationPointIcon as HugeFileExclamationPointIcon,
	FileIcon as HugeFileIcon,
	FileImageIcon as HugeFileImageIcon,
	FileSpreadsheetIcon as HugeFileSpreadsheetIcon,
	FileTextIcon as HugeFileTextIcon,
	FileTypeIcon as HugeFileTypeIcon,
	FileVideoCameraIcon as HugeFileVideoCameraIcon,
	FileVideoIcon as HugeFileVideoIcon,
	FolderIcon as HugeFolderIcon,
	FolderInputIcon as HugeFolderInputIcon,
	FolderPlusIcon as HugeFolderPlusIcon,
	GlobalIcon as HugeGlobeIcon,
	HardDriveIcon as HugeHardDriveIcon,
	HelpCircleIcon as HugeHelpCircleIcon,
	ImageIcon as HugeImageIcon,
	ImagePlusIcon as HugeImagePlusIcon,
	InboxIcon as HugeInboxIcon,
	InfoIcon as HugeInfoIcon,
	ItalicIcon as HugeItalicIcon,
	KeyRoundIcon as HugeKeyRoundIcon,
	KeyboardIcon as HugeKeyboardIcon,
	Layout2ColumnIcon as HugeLayout2ColumnIcon,
	Link02Icon as HugeLink02Icon,
	ListChecksIcon as HugeListChecksIcon,
	ListFilterIcon as HugeListFilterIcon,
	ListIcon as HugeListIcon,
	ListOrderedIcon as HugeListOrderedIcon,
	Loading03Icon as HugeLoading03Icon,
	LockKeyholeIcon as HugeLockKeyholeIcon,
	LogInIcon as HugeLogInIcon,
	LogOutIcon as HugeLogOutIcon,
	MailCheckIcon as HugeMailCheckIcon,
	MailIcon as HugeMailIcon,
	MailOpenIcon as HugeMailOpenIcon,
	MailPlusIcon as HugeMailPlusIcon,
	MapPinIcon as HugeMapPinIcon,
	ExpandIcon as HugeMaximize02Icon,
	Menu10Icon as HugeMenuIcon,
	CollapseIcon as HugeMinimize02Icon,
	MinusIcon as HugeMinusIcon,
	MoreHorizontalIcon as HugeMoreHorizontalIcon,
	MoreVerticalIcon as HugeMoreVerticalIcon,
	MusicIcon as HugeMusicIcon,
	PaletteIcon as HugePaletteIcon,
	PaperclipIcon as HugePaperclipIcon,
	PauseCircleIcon as HugePauseCircleIcon,
	PauseIcon as HugePauseIcon,
	PenLineIcon as HugePenLineIcon,
	PencilIcon as HugePencilIcon,
	PlayIcon as HugePlayIcon,
	PlusIcon as HugePlusIcon,
	PresentationIcon as HugePresentationIcon,
	QuoteIcon as HugeQuoteIcon,
	RefreshCwIcon as HugeRefreshCwIcon,
	RemoveFormattingIcon as HugeRemoveFormattingIcon,
	RepeatIcon as HugeRepeatIcon,
	ReplyAllIcon as HugeReplyAllIcon,
	ReplyIcon as HugeReplyIcon,
	RotateCcwIcon as HugeRotateCcwIcon,
	RotateCwIcon as HugeRotateCwIcon,
	RouteIcon as HugeRouteIcon,
	SaveIcon as HugeSaveIcon,
	SearchIcon as HugeSearchIcon,
	SendIcon as HugeSendIcon,
	ServerIcon as HugeServerIcon,
	Settings02Icon as HugeSettings02Icon,
	SettingsIcon as HugeSettingsIcon,
	Share02Icon as HugeShare02Icon,
	ShieldAlertIcon as HugeShieldAlertIcon,
	ShieldCheckIcon as HugeShieldCheckIcon,
	ShieldIcon as HugeShieldIcon,
	ShieldOffIcon as HugeShieldOffIcon,
	SmartphoneIcon as HugeSmartphoneIcon,
	SparklesIcon as HugeSparklesIcon,
	SquareIcon as HugeSquareIcon,
	StarIcon as HugeStarIcon,
	StrikethroughIcon as HugeStrikethroughIcon,
	TextAlignJustifyIcon as HugeTextAlignJustifyIcon,
	TextAlignLeftIcon as HugeTextAlignLeftIcon,
	TriangleAlertIcon as HugeTriangleAlertIcon,
	UnderlineIcon as HugeUnderlineIcon,
	Undo02Icon as HugeUndo02Icon,
	UnfoldMoreIcon as HugeUnfoldMoreIcon,
	UploadIcon as HugeUploadIcon,
	UserIcon as HugeUserIcon,
	UserPlusIcon as HugeUserPlusIcon,
	UserRoundIcon as HugeUserRoundIcon,
	UsersIcon as HugeUsersIcon,
	UsersRoundIcon as HugeUsersRoundIcon,
	WebhookIcon as HugeWebhookIcon,
	WrenchIcon as HugeWrenchIcon,
	XIcon as HugeXIcon,
} from "@hugeicons/core-free-icons";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
	size?: string | number;
	strokeWidth?: number;
	absoluteStrokeWidth?: boolean;
};

export type LucideIcon = ComponentType<IconProps>;
export type IconNode = LucideIcon;

function createIcon(icon: IconSvgElement, displayName: string): LucideIcon {
	const Icon = forwardRef<SVGSVGElement, IconProps>((props, ref) => (
		<HugeiconsIcon ref={ref} icon={icon} strokeWidth={2} {...props} />
	));
	Icon.displayName = displayName;
	return Icon;
}

export const Activity = createIcon(HugeActivityIcon, "Activity");
export const AlertCircle = createIcon(HugeAlertCircleIcon, "AlertCircle");
export const AlertTriangle = createIcon(HugeTriangleAlertIcon, "AlertTriangle");
export const AlignLeft = createIcon(HugeTextAlignLeftIcon, "AlignLeft");
export const Archive = createIcon(HugeArchiveIcon, "Archive");
export const ArchiveRestore = createIcon(HugeArchiveRestoreIcon, "ArchiveRestore");
export const ArrowDown = createIcon(HugeArrowDownIcon, "ArrowDown");
export const ArrowDownToLine = createIcon(HugeArrowDownToLineIcon, "ArrowDownToLine");
export const ArrowLeft = createIcon(HugeArrowLeftIcon, "ArrowLeft");
export const ArrowRight = createIcon(HugeArrowRightIcon, "ArrowRight");
export const ArrowUp = createIcon(HugeArrowUpIcon, "ArrowUp");
export const AtSign = createIcon(HugeAtSignIcon, "AtSign");
export const BadgeDollarSign = createIcon(HugeBadgeDollarSignIcon, "BadgeDollarSign");
export const Ban = createIcon(HugeBanIcon, "Ban");
export const Bell = createIcon(HugeBellIcon, "Bell");
export const BellOff = createIcon(HugeBellOffIcon, "BellOff");
export const BellRing = createIcon(HugeBellRingIcon, "BellRing");
export const Bold = createIcon(HugeBoldIcon, "Bold");
export const Bot = createIcon(HugeBotIcon, "Bot");
export const Building2 = createIcon(HugeBuilding02Icon, "Building2");
export const CalendarClock = createIcon(HugeCalendarClockIcon, "CalendarClock");
export const CalendarDays = createIcon(HugeCalendarDaysIcon, "CalendarDays");
export const CalendarPlus2 = createIcon(HugeCalendarAdd02Icon, "CalendarPlus2");
export const Camera = createIcon(HugeCameraIcon, "Camera");
export const Check = createIcon(HugeCheckIcon, "Check");
export const CheckCircle2 = createIcon(HugeCheckmarkCircle02Icon, "CheckCircle2");
export const CheckSquare2 = createIcon(HugeCheckmarkSquare02Icon, "CheckSquare2");
export const ChevronDown = createIcon(HugeChevronDownIcon, "ChevronDown");
export const ChevronLeft = createIcon(HugeChevronLeftIcon, "ChevronLeft");
export const ChevronRight = createIcon(HugeChevronRightIcon, "ChevronRight");
export const ChevronUp = createIcon(HugeChevronUpIcon, "ChevronUp");
export const ChevronsUpDown = createIcon(HugeUnfoldMoreIcon, "ChevronsUpDown");
export const CircleX = createIcon(HugeCircleXIcon, "CircleX");
export const Clock = createIcon(HugeClockIcon, "Clock");
export const Clock3 = createIcon(HugeClock03Icon, "Clock3");
export const Cloud = createIcon(HugeCloudIcon, "Cloud");
export const Columns2 = createIcon(HugeLayout2ColumnIcon, "Columns2");
export const Copy = createIcon(HugeCopyIcon, "Copy");
export const CornerDownLeft = createIcon(HugeCornerDownLeftIcon, "CornerDownLeft");
export const CornerDownRight = createIcon(HugeCornerDownRightIcon, "CornerDownRight");
export const Database = createIcon(HugeDatabaseIcon, "Database");
export const DatabaseBackup = createIcon(HugeDatabaseBackupIcon, "DatabaseBackup");
export const Download = createIcon(HugeDownloadIcon, "Download");
export const ExternalLink = createIcon(HugeExternalLinkIcon, "ExternalLink");
export const Eye = createIcon(HugeEyeIcon, "Eye");
export const EyeOff = createIcon(HugeEyeOffIcon, "EyeOff");
export const File = createIcon(HugeFileIcon, "File");
export const FileArchive = createIcon(HugeFileArchiveIcon, "FileArchive");
export const FileAudio = createIcon(HugeFileAudioIcon, "FileAudio");
export const FileCode = createIcon(HugeFileCodeIcon, "FileCode");
export const FileCode2 = createIcon(HugeFileCodeCornerIcon, "FileCode2");
export const FileImage = createIcon(HugeFileImageIcon, "FileImage");
export const FileSpreadsheet = createIcon(HugeFileSpreadsheetIcon, "FileSpreadsheet");
export const FileText = createIcon(HugeFileTextIcon, "FileText");
export const FileType = createIcon(HugeFileTypeIcon, "FileType");
export const FileVideo = createIcon(HugeFileVideoIcon, "FileVideo");
export const FileVideoCamera = createIcon(HugeFileVideoCameraIcon, "FileVideoCamera");
export const FileWarning = createIcon(HugeFileExclamationPointIcon, "FileWarning");
export const Folder = createIcon(HugeFolderIcon, "Folder");
export const FolderInput = createIcon(HugeFolderInputIcon, "FolderInput");
export const FolderPlus = createIcon(HugeFolderPlusIcon, "FolderPlus");
export const Forward = function (props) {
	return createElement(createIcon(HugeReplyIcon, "Forward"), {...props, className: `${props.className} scale-x-[-1]`});
}
export const Globe2 = createIcon(HugeGlobeIcon, "Globe2");
export const HardDrive = createIcon(HugeHardDriveIcon, "HardDrive");
export const HelpCircle = createIcon(HugeHelpCircleIcon, "HelpCircle");
export const Image = createIcon(HugeImageIcon, "Image");
export const ImagePlus = createIcon(HugeImagePlusIcon, "ImagePlus");
export const Inbox = createIcon(HugeInboxIcon, "Inbox");
export const Info = createIcon(HugeInfoIcon, "Info");
export const Italic = createIcon(HugeItalicIcon, "Italic");
export const KeyRound = createIcon(HugeKeyRoundIcon, "KeyRound");
export const Keyboard = createIcon(HugeKeyboardIcon, "Keyboard");
export const Link2 = createIcon(HugeLink02Icon, "Link2");
export const List = createIcon(HugeListIcon, "List");
export const ListChecks = createIcon(HugeListChecksIcon, "ListChecks");
export const ListFilter = createIcon(HugeListFilterIcon, "ListFilter");
export const ListOrdered = createIcon(HugeListOrderedIcon, "ListOrdered");
export const Loader2 = createIcon(HugeLoading03Icon, "Loader2");
export const LockKeyhole = createIcon(HugeLockKeyholeIcon, "LockKeyhole");
export const LogIn = createIcon(HugeLogInIcon, "LogIn");
export const LogOut = createIcon(HugeLogOutIcon, "LogOut");
export const Mail = createIcon(HugeMailIcon, "Mail");
export const MailCheck = createIcon(HugeMailCheckIcon, "MailCheck");
export const MailOpen = createIcon(HugeMailOpenIcon, "MailOpen");
export const MailPlus = createIcon(HugeMailPlusIcon, "MailPlus");
export const MapPin = createIcon(HugeMapPinIcon, "MapPin");
export const Maximize2 = createIcon(HugeMaximize02Icon, "Maximize2");
export const Menu = createIcon(HugeMenuIcon, "Menu");
export const Minimize2 = createIcon(HugeMinimize02Icon, "Minimize2");
export const Minus = createIcon(HugeMinusIcon, "Minus");
export const MoreHorizontal = createIcon(HugeMoreHorizontalIcon, "MoreHorizontal");
export const MoreVertical = createIcon(HugeMoreVerticalIcon, "MoreVertical");
export const Music = createIcon(HugeMusicIcon, "Music");
export const Palette = createIcon(HugePaletteIcon, "Palette");
export const Paperclip = createIcon(HugePaperclipIcon, "Paperclip");
export const Pause = createIcon(HugePauseIcon, "Pause");
export const PauseCircle = createIcon(HugePauseCircleIcon, "PauseCircle");
export const PenLine = createIcon(HugePenLineIcon, "PenLine");
export const Pencil = createIcon(HugePencilIcon, "Pencil");
export const Play = createIcon(HugePlayIcon, "Play");
export const Plus = createIcon(HugePlusIcon, "Plus");
export const Presentation = createIcon(HugePresentationIcon, "Presentation");
export const Quote = createIcon(HugeQuoteIcon, "Quote");
export const RefreshCw = createIcon(HugeRefreshCwIcon, "RefreshCw");
export const RemoveFormatting = createIcon(HugeRemoveFormattingIcon, "RemoveFormatting");
export const Repeat2 = createIcon(HugeRepeatIcon, "Repeat2");
export const Reply = createIcon(HugeReplyIcon, "Reply");
export const ReplyAll = createIcon(HugeReplyAllIcon, "ReplyAll");
export const RotateCcw = createIcon(HugeRotateCcwIcon, "RotateCcw");
export const RotateCw = createIcon(HugeRotateCwIcon, "RotateCw");
export const Route = createIcon(HugeRouteIcon, "Route");
export const Save = createIcon(HugeSaveIcon, "Save");
export const Search = createIcon(HugeSearchIcon, "Search");
export const Send = createIcon(HugeSendIcon, "Send");
export const Server = createIcon(HugeServerIcon, "Server");
export const Settings = createIcon(HugeSettingsIcon, "Settings");
export const Settings2 = createIcon(HugeSettings02Icon, "Settings2");
export const Share2 = createIcon(HugeShare02Icon, "Share2");
export const Shield = createIcon(HugeShieldIcon, "Shield");
export const ShieldAlert = createIcon(HugeShieldAlertIcon, "ShieldAlert");
export const ShieldCheck = createIcon(HugeShieldCheckIcon, "ShieldCheck");
export const ShieldOff = createIcon(HugeShieldOffIcon, "ShieldOff");
export const Smartphone = createIcon(HugeSmartphoneIcon, "Smartphone");
export const Sparkles = createIcon(HugeSparklesIcon, "Sparkles");
export const Square = createIcon(HugeSquareIcon, "Square");
export const Star = createIcon(HugeStarIcon, "Star");
export const Strikethrough = createIcon(HugeStrikethroughIcon, "Strikethrough");
export const TextAlignJustify = createIcon(HugeTextAlignJustifyIcon, "TextAlignJustify");
export const Trash2 = createIcon(HugeDelete02Icon, "Trash2");
export const Underline = createIcon(HugeUnderlineIcon, "Underline");
export const Undo2 = createIcon(HugeUndo02Icon, "Undo2");
export const Upload = createIcon(HugeUploadIcon, "Upload");
export const UploadCloud = createIcon(HugeCloudUploadIcon, "UploadCloud");
export const User = createIcon(HugeUserIcon, "User");
export const UserPlus = createIcon(HugeUserPlusIcon, "UserPlus");
export const UserRound = createIcon(HugeUserRoundIcon, "UserRound");
export const Users = createIcon(HugeUsersIcon, "Users");
export const UsersRound = createIcon(HugeUsersRoundIcon, "UsersRound");
export const Webhook = createIcon(HugeWebhookIcon, "Webhook");
export const Wrench = createIcon(HugeWrenchIcon, "Wrench");
export const X = createIcon(HugeXIcon, "X");
export const XCircle = createIcon(HugeCancelCircleIcon, "XCircle");
export const LoaderCircle = Loader2;
export const ArchiveIcon = Archive;
export const InboxIcon = Inbox;
export const ShieldIcon = Shield;
export const ShieldAlertIcon = ShieldAlert;
export const Trash2Icon = Trash2;
export const TrashIcon = Trash2;
