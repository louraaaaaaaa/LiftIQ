const MAX_CHART_POINTS = 240;

// Rolling line chart of dynamic acceleration on a <canvas>.
export class SignalChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.values = [];
    this.frame = null;
  }

  push(value) {
    this.values.push(value);
    if (this.values.length > MAX_CHART_POINTS) this.values.shift();
    this.schedule();
  }

  clear() {
    this.values.length = 0;
    this.draw();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  draw() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const scale = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * scale);
    canvas.height = Math.round(rect.height * scale);
    const context = canvas.getContext("2d");
    context.scale(scale, scale);
    const { width, height } = rect;
    const padding = { top: 9, right: 6, bottom: 8, left: 6 };
    const graphWidth = width - padding.left - padding.right;
    const graphHeight = height - padding.top - padding.bottom;
    context.clearRect(0, 0, width, height);
    context.strokeStyle = "rgba(151, 164, 151, .12)";
    context.lineWidth = 1;
    for (let line = 0; line < 4; line++) {
      const y = padding.top + graphHeight * line / 3;
      context.beginPath();
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
    }
    if (this.values.length < 2) return;
    const maxMagnitude = Math.max(.5, ...this.values.map((value) => Math.abs(value)));
    context.beginPath();
    context.strokeStyle = "#c5f36b";
    context.lineWidth = 1.8;
    context.lineJoin = "round";
    context.lineCap = "round";
    this.values.forEach((value, index) => {
      const x = padding.left + graphWidth * index / (this.values.length - 1);
      const y = padding.top + graphHeight * (1 - (value / maxMagnitude + 1) / 2);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  }
}
