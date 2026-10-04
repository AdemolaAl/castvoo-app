'use strict';

// Castvoo email layout.
// Table-based, inline styles only, no images. Works in Gmail, Outlook,
// Apple Mail and mobile clients. Variables like {{first_name}} are left
// untouched here; the caller replaces them over the final string.

const FONT = "'Plus Jakarta Sans', Arial, Helvetica, sans-serif";
const MONO = "'JetBrains Mono', 'SFMono-Regular', Menlo, Consolas, 'Courier New', monospace";

const C = {
  bg: '#F3F6FC',
  card: '#FFFFFF',
  blue: '#2F6BFF',
  navy: '#0B1430',
  text: '#33405C',
  muted: '#6B7690',
  line: '#E3E8F2',
  soft: '#EEF3FF',
};

// ---------- Small building blocks used by templates ----------

function h1(text) {
  return `<h1 style="margin:0 0 16px 0;font-family:${FONT};font-size:24px;line-height:1.3;font-weight:800;color:${C.navy};letter-spacing:-0.3px;">${text}</h1>`;
}

function p(text, extra = '') {
  return `<p style="margin:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.text};${extra}">${text}</p>`;
}

function small(text) {
  return `<p style="margin:0 0 12px 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${C.muted};">${text}</p>`;
}

// Bulletproof table-cell button. Degrades to a plain blue link.
function button(url, label) {
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" style="margin:8px 0 24px 0;border-collapse:separate;">
<tr><td align="center" bgcolor="${C.blue}" style="background-color:${C.blue};border-radius:12px;mso-padding-alt:14px 26px;">
<a href="${url}" target="_blank" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px;background-color:${C.blue};">${label}</a>
</td></tr></table>`;
}

// Soft blue info box.
function infoBox(html) {
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:4px 0 20px 0;border-collapse:separate;">
<tr><td bgcolor="${C.soft}" style="background-color:${C.soft};border-radius:14px;padding:18px 20px;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};">${html}</td></tr></table>`;
}

// Receipt-style table: rows = [[label, value], ...]. Last row can be bold.
function receipt(rows, { boldLast = false } = {}) {
  const trs = rows
    .map(([label, value], i) => {
      const last = i === rows.length - 1;
      const weight = boldLast && last ? '800' : '600';
      const border = last ? '' : `border-bottom:1px solid ${C.line};`;
      return `<tr>
<td valign="top" style="padding:12px 16px 12px 0;${border}font-family:${FONT};font-size:14px;line-height:1.4;color:${C.muted};white-space:nowrap;">${label}</td>
<td align="right" valign="top" style="padding:12px 0;${border}font-family:${FONT};font-size:14px;line-height:1.4;color:${C.navy};font-weight:${weight};word-break:break-all;">${value}</td>
</tr>`;
    })
    .join('\n');
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:4px 0 24px 0;border-collapse:separate;">
<tr><td style="border:1px solid ${C.line};border-radius:14px;padding:4px 20px;">
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">${trs}</table>
</td></tr></table>`;
}

// Numbered steps: items = [[title, text], ...]
function steps(items) {
  const rows = items
    .map(([title, text], i) => `<tr>
<td valign="top" width="40" style="padding:0 0 16px 0;">
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
<td align="center" valign="middle" width="28" height="28" bgcolor="${C.soft}" style="width:28px;height:28px;background-color:${C.soft};border-radius:14px;font-family:${FONT};font-size:14px;font-weight:800;color:${C.blue};line-height:28px;">${i + 1}</td>
</tr></table>
</td>
<td valign="top" style="padding:3px 0 16px 0;font-family:${FONT};font-size:15px;line-height:1.6;color:${C.text};"><strong style="color:${C.navy};">${title}</strong><br>${text}</td>
</tr>`)
    .join('\n');
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:4px 0 12px 0;">${rows}</table>`;
}

// Big login code.
function codeBox(code, { size = 34, spacing = 10 } = {}) {
  return `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="margin:4px 0 20px 0;border-collapse:separate;">
<tr><td align="center" bgcolor="${C.soft}" style="background-color:${C.soft};border-radius:14px;padding:22px 12px;font-family:${MONO};font-size:${size}px;line-height:1.2;font-weight:700;letter-spacing:${spacing}px;color:${C.navy};word-break:break-all;">${code}</td></tr></table>`;
}

// Monospace inline value (addresses, transaction IDs).
function mono(text) {
  return `<span style="font-family:${MONO};font-size:13px;color:${C.navy};word-break:break-all;">${text}</span>`;
}

function signoff(name) {
  return `<p style="margin:8px 0 0 0;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.text};">${name}</p>`;
}

// ---------- The full email ----------

function layout({ subject = '', preheader = '', body = '', category = 'transactional', vars } = {}) {
  void vars; // variables are replaced by the caller
  const isMarketing = category === 'marketing';

  // Pad the preheader so email clients don't pull body text into the preview.
  const pad = '&#847; &zwnj; &nbsp; '.repeat(30);

  const linkStyle = `color:${C.muted};text-decoration:underline;`;

  const marketingFooter = isMarketing
    ? `<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">You're getting this because you signed up for a Castvoo trial. <a href="{{unsubscribe_url}}" target="_blank" style="${linkStyle}">Unsubscribe</a></p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${subject}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light; supported-color-schemes: light; }
  body { margin:0 !important; padding:0 !important; width:100% !important; background-color:${C.bg}; }
  a { color:${C.blue}; }
  @media only screen and (max-width:600px) {
    .cv-outer { padding:16px 10px !important; }
    .cv-card { padding:28px 22px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${C.bg};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${preheader}${pad}</div>
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${C.bg}" style="background-color:${C.bg};">
<tr><td align="center" class="cv-outer" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="560" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->
<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;width:100%;">

<!-- Header -->
<tr><td style="padding:0 4px 20px 4px;">
<table role="presentation" border="0" cellspacing="0" cellpadding="0"><tr>
<td width="40" height="40" align="center" valign="middle" bgcolor="${C.blue}" style="width:40px;height:40px;background-color:${C.blue};border-radius:12px;font-family:${FONT};font-size:22px;line-height:40px;font-weight:800;color:#FFFFFF;">C</td>
<td style="padding-left:10px;font-family:${FONT};font-size:22px;line-height:40px;font-weight:800;letter-spacing:-0.4px;"><a href="{{site_url}}" target="_blank" style="text-decoration:none;"><span style="color:${C.navy};">Cast</span><span style="color:${C.blue};">voo</span></a></td>
</tr></table>
</td></tr>

<!-- Card -->
<tr><td class="cv-card" bgcolor="${C.card}" style="background-color:${C.card};border-radius:20px;padding:36px 36px 32px 36px;border:1px solid ${C.line};">
${body}
</td></tr>

<!-- Footer -->
<tr><td style="padding:24px 8px 8px 8px;text-align:center;">
${marketingFooter}
<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">Questions? Write to <a href="mailto:{{support_email}}" style="${linkStyle}">{{support_email}}</a></p>
<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};"><a href="{{site_url}}/legal/privacy" target="_blank" style="${linkStyle}">Privacy</a> &nbsp;·&nbsp; <a href="{{site_url}}/legal/terms" target="_blank" style="${linkStyle}">Terms</a></p>
<p style="margin:0 0 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">{{company_name}} · {{company_address}}</p>
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.6;color:${C.muted};">Castvoo is not affiliated with Telegram.</p>
</td></tr>

</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

module.exports = { layout, h1, p, small, button, infoBox, receipt, steps, codeBox, mono, signoff, COLORS: C };
