export interface UIInterface {
  colors: Record<string, string>;
  box: Record<string, string>;
  printHeader(title: string, subtitle?: string): void;
  printCard(title: string, bodyLines: string | string[], highlight?: boolean): void;
  printSuccess(msg: string): void;
  printInfo(msg: string): void;
  printWarning(msg: string): void;
  printError(msg: string): void;
  printFatalBox(title: string, lines: string[]): void;
  createSpinner(text: string): {
    start(): unknown;
    stop(text?: string): void;
    fail(text?: string): void;
  };
}

export declare const UI: UIInterface;
export default UI;
