export async function exportCanvas(canvas, format) {
  switch (format) {
    case 'png':
      _dl(canvas.toDataURL('image/png'), 'soundform.png');
      break;

    case 'jpg':
      _dl(_onBlack(canvas, 'image/jpeg', 0.95), 'soundform.jpg');
      break;

    case 'webp':
      _dl(canvas.toDataURL('image/webp', 0.95), 'soundform.webp');
      break;

    case 'pdf': {
      const { jsPDF } = window.jspdf;
      const w = canvas.width, h = canvas.height;
      const mmW = w > h ? 297 : 210;
      const mmH = mmW * (h / w);
      const doc = new jsPDF({
        orientation: w > h ? 'landscape' : 'portrait',
        unit: 'mm',
        format: [mmW, mmH],
      });
      doc.addImage(_onBlack(canvas, 'image/jpeg', 0.92), 'JPEG', 0, 0, mmW, mmH);
      doc.save('soundform.pdf');
      break;
    }
  }
}

// Composite WebGL canvas (alpha channel) onto a solid background before saving as JPEG
function _onBlack(canvas, mime, quality) {
  const tmp = document.createElement('canvas');
  tmp.width  = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#060810';
  ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(canvas, 0, 0);
  return tmp.toDataURL(mime, quality);
}

function _dl(url, name) {
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
