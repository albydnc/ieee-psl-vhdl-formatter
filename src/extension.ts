import * as vscode from "vscode";
import { PSLFormatter } from "./formatter";

export function activate(context: vscode.ExtensionContext) {
  const formatter = new PSLFormatter();

  // Register formatter for PSL language
  const formatterDisposable =
    vscode.languages.registerDocumentFormattingEditProvider("psl", {
      provideDocumentFormattingEdits(
        document: vscode.TextDocument
      ): vscode.TextEdit[] {
        return formatter.formatDocument(document);
      },
    });

  // Register range formatter
  const rangeFormatterDisposable =
    vscode.languages.registerDocumentRangeFormattingEditProvider("psl", {
      provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        range: vscode.Range
      ): vscode.TextEdit[] {
        return formatter.formatRange(document, range);
      },
    });

  context.subscriptions.push(formatterDisposable, rangeFormatterDisposable);
}

export function deactivate() {}