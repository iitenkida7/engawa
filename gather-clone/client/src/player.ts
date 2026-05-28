import type { Player } from './types';

export class PlayerState implements Player {
  userId: string;
  name: string;
  x: number;
  y: number;

  // for remote players: interpolation target
  targetX: number;
  targetY: number;

  color: string;
  isSelf: boolean;
  isSpeaking = false;
  isMuted = false;
  isVideoOn = false;
  isSharingScreen = false;

  constructor(p: Player, isSelf: boolean) {
    this.userId = p.userId;
    this.name = p.name;
    this.x = p.x;
    this.y = p.y;
    this.targetX = p.x;
    this.targetY = p.y;
    this.isSelf = isSelf;
    this.color = colorForId(p.userId);
  }

  setTarget(x: number, y: number) {
    this.targetX = x;
    this.targetY = y;
  }

  interpolate() {
    // smoothly move toward target
    const ax = (this.targetX - this.x) * 0.25;
    const ay = (this.targetY - this.y) * 0.25;
    this.x += ax;
    this.y += ay;
  }

  initials() {
    const name = this.name || '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
}

function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}
