// Types for the landing-page snippet (voo-connect-browser.js), which sets window.VooConnect.
export interface VooConnectBrowser {
  /** The kept affiliate click: { ref, vclick, coupon } (only the ones present). */
  params(): { ref?: string; vclick?: string; coupon?: string };
  /** Adds the kept ref / vclick / coupon to a URL (never overwrites ones already there). */
  decorate(url: string): string;
  /** Decorates the matching links again (call after rendering new "Start free" buttons). */
  refresh(root?: ParentNode): void;
  /** Forgets the kept click (cookie and sessionStorage). */
  clear(): void;
  version: string;
}
declare global {
  interface Window { VooConnect: VooConnectBrowser }
}
export {};
