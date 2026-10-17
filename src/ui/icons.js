import {
  BookOpen, Check, ChevronDown, ChevronRight, Circle, Download, Droplet, Eye, Info, Layers, Map,
  MapPin, Minus, MoreHorizontal, MousePointer2, Move, PanelRightClose, PanelRightOpen,
  Plus, RotateCcw, Ruler, Search, Settings, Shield, SlidersHorizontal, Sparkles, Trash2,
  Undo2, Upload, User, Users, X,
} from 'lucide';

const ICONS = Object.freeze({
  'book-open': BookOpen,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  circle: Circle,
  download: Download,
  droplet: Droplet,
  eye: Eye,
  info: Info,
  layers: Layers,
  map: Map,
  'map-pin': MapPin,
  minus: Minus,
  'more-horizontal': MoreHorizontal,
  'mouse-pointer-2': MousePointer2,
  move: Move,
  'panel-right-close': PanelRightClose,
  'panel-right-open': PanelRightOpen,
  plus: Plus,
  'rotate-ccw': RotateCcw,
  ruler: Ruler,
  search: Search,
  settings: Settings,
  shield: Shield,
  sparkles: Sparkles,
  sliders: SlidersHorizontal,
  'sliders-horizontal': SlidersHorizontal,
  'trash-2': Trash2,
  'undo-2': Undo2,
  upload: Upload,
  user: User,
  users: Users,
  x: X,
});

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

function iconSize(value) {
  const size = Number(value);
  return Number.isFinite(size) ? Math.max(8, Math.min(96, size)) : 18;
}

function iconAttributes(size) {
  return {
    class: 'ui-icon', width: iconSize(size), height: iconSize(size),
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  };
}

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function attributesMarkup(attributes) {
  return Object.entries(attributes).map(([name, value]) => `${name}="${escapeAttribute(value)}"`).join(' ');
}

export function renderUiIcon(name, { size = 18 } = {}) {
  const icon = Object.hasOwn(ICONS, name) ? ICONS[name] : Circle;
  const children = icon.map(([tag, attributes]) => `<${tag} ${attributesMarkup(attributes)}></${tag}>`).join('');
  return `<svg ${attributesMarkup(iconAttributes(size))}>${children}</svg>`;
}

export function createUiIcon(documentNode, name, { size = 18 } = {}) {
  const element = documentNode.createElementNS(SVG_NAMESPACE, 'svg');
  for (const [key, value] of Object.entries(iconAttributes(size))) element.setAttribute(key, String(value));
  const icon = Object.hasOwn(ICONS, name) ? ICONS[name] : Circle;
  for (const [tag, attributes] of icon) {
    const child = documentNode.createElementNS(SVG_NAMESPACE, tag);
    for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, String(value));
    element.append(child);
  }
  return element;
}
