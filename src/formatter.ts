import * as vscode from "vscode";

interface FormatOptions {
    indentSize: number;
    maxLineLength: number;
    alignOperators: boolean;
}

export class PSLFormatter {
    private getOptions(): FormatOptions {
        const config = vscode.workspace.getConfiguration("pslVhdlFormatter");
        return {
            indentSize: config.get<number>("indentSize", 2),
            maxLineLength: config.get<number>("maxLineLength", 80),
            alignOperators: config.get<boolean>("alignOperators", true),
        };
    }

    public formatDocument(document: vscode.TextDocument): vscode.TextEdit[] {
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );
        return this.formatRange(document, fullRange);
    }

    public formatRange(
        document: vscode.TextDocument,
        range: vscode.Range
    ): vscode.TextEdit[] {
        const edits: vscode.TextEdit[] = [];
        const options = this.getOptions();
        let indentLevel = this.calculateInitialIndent(document, range.start.line);
        let baseIndent = 0;
        let inProperty = false;

        // Collect assertions in groups separated by empty lines
        const assertionGroups = this.collectAssertionGroups(document, range);

        for (let i = range.start.line; i <= range.end.line; i++) {
            const line = document.lineAt(i);
            const trimmedText = line.text.trim();

            if (trimmedText === "") {
                continue;
            }

            // Comments keep their indentation context
            if (this.isComment(trimmedText)) {
                const indent = " ".repeat(indentLevel * options.indentSize);
                const formattedLine = indent + trimmedText;
                const lineRange = new vscode.Range(line.range.start, line.range.end);
                if (formattedLine !== line.text) {
                    edits.push(vscode.TextEdit.replace(lineRange, formattedLine));
                }
                continue;
            }

            const decreaseIndentBefore = this.shouldDecreaseIndentBefore(
                trimmedText
            );
            const increaseIndentAfter = this.shouldIncreaseIndentAfter(
                trimmedText
            );

            // Track base indent when entering vunit/vmode blocks
            if (this.isVunitStart(trimmedText)) {
                baseIndent = indentLevel + 1;
            }

            // Track property blocks
            if (this.isPropertyStart(trimmedText)) {
                inProperty = true;
            }

            if (decreaseIndentBefore && indentLevel > 0) {
                indentLevel--;
            }

            // Reset indent for assertions to base level
            let effectiveIndent = indentLevel;
            if (this.isAssertion(trimmedText)) {
                effectiveIndent = baseIndent;
                // Find which group this assertion belongs to
                const maxLabelLength = this.findMaxLabelLengthForLine(
                    assertionGroups,
                    i
                );
                const formattedLine = this.formatAssertion(
                    trimmedText,
                    effectiveIndent,
                    maxLabelLength,
                    options
                );
                const lineRange = new vscode.Range(line.range.start, line.range.end);
                if (formattedLine !== line.text) {
                    edits.push(vscode.TextEdit.replace(lineRange, formattedLine));
                }
                continue;
            }

            // Property content uses increased indent
            if (inProperty && !this.isPropertyStart(trimmedText)) {
                effectiveIndent = indentLevel;
            }

            const formattedLine = this.formatLine(
                trimmedText,
                effectiveIndent,
                options
            );
            const lineRange = new vscode.Range(line.range.start, line.range.end);

            if (formattedLine !== line.text) {
                edits.push(vscode.TextEdit.replace(lineRange, formattedLine));
            }

            if (increaseIndentAfter) {
                indentLevel++;
            }

            // Reset indent when property ends with semicolon
            if (this.isPropertyEnd(trimmedText) && inProperty) {
                inProperty = false;
                indentLevel = baseIndent;
            }
        }

        return edits;
    }

    private collectAssertionGroups(
        document: vscode.TextDocument,
        range: vscode.Range
    ): Map<number, string[]> {
        const groups = new Map<number, string[]>();
        let currentGroup: string[] = [];
        let groupStartLine = -1;
        let lastNonEmptyLine = -1;

        for (let i = range.start.line; i <= range.end.line; i++) {
            const text = document.lineAt(i).text.trim();

            // Check if empty line gap
            if (lastNonEmptyLine >= 0 && i - lastNonEmptyLine > 1 && currentGroup.length > 0) {
                // Save current group
                for (let j = 0; j < currentGroup.length; j++) {
                    groups.set(groupStartLine + j, currentGroup);
                }
                // Start new group
                currentGroup = [];
                groupStartLine = -1;
            }

            if (text !== "" && !this.isComment(text)) {
                lastNonEmptyLine = i;
            }

            if (this.isAssertion(text)) {
                if (currentGroup.length === 0) {
                    groupStartLine = i;
                }
                currentGroup.push(text);
                groups.set(i, currentGroup);
            }
        }

        return groups;
    }

    private findMaxLabelLengthForLine(
        assertionGroups: Map<number, string[]>,
        lineNumber: number
    ): number {
        const group = assertionGroups.get(lineNumber);
        if (!group) {
            return 0;
        }
        return this.findMaxLabelLength(group);
    }

    private collectAssertions(
        document: vscode.TextDocument,
        range: vscode.Range
    ): string[] {
        const assertions: string[] = [];
        for (let i = range.start.line; i <= range.end.line; i++) {
            const text = document.lineAt(i).text.trim();
            if (this.isAssertion(text)) {
                assertions.push(text);
            }
        }
        return assertions;
    }


    private findMaxLabelLength(assertions: string[]): number {
        let maxLength = 0;
        for (const assertion of assertions) {
            const match = assertion.match(/^(\w+)\s*:/);
            if (match) {
                maxLength = Math.max(maxLength, match[1].length);
            }
        }
        return maxLength;
    }

    private formatAssertion(
        text: string,
        indentLevel: number,
        maxLabelLength: number,
        options: FormatOptions
    ): string {
        const indent = " ".repeat(indentLevel * options.indentSize);
        const match = text.match(/^(\w+)\s*:\s*(assert|assume|cover|restrict)(.*)$/i);

        if (!match) {
            return this.formatLine(text, indentLevel, options);
        }

        const [, label, keyword, rest] = match;
        const padding = " ".repeat(maxLabelLength - label.length);
        const formattedRest = this.formatExpression(rest.trim());

        return `${indent}${label}: ${padding}${keyword.toLowerCase()} ${formattedRest}`;
    }

    private calculateInitialIndent(
        document: vscode.TextDocument,
        startLine: number
    ): number {
        let indent = 0;
        for (let i = 0; i < startLine; i++) {
            const text = document.lineAt(i).text.trim();
            if (this.isComment(text) || text === "") {
                continue;
            }
            if (this.shouldIncreaseIndentAfter(text)) {
                indent++;
            }
            if (this.shouldDecreaseIndentBefore(text) && indent > 0) {
                indent--;
            }
        }
        return Math.max(0, indent);
    }

    private formatLine(
        text: string,
        indentLevel: number,
        options: FormatOptions
    ): string {
        const indent = " ".repeat(indentLevel * options.indentSize);
        const formatted = this.formatExpression(text);
        return indent + formatted;
    }

    private formatExpression(text: string): string {

        // Protect multi-char operators
        const opMarker = "§OP§";
        const ops: string[] = [];
        text = text.replace(/(:=|<=|=>|\|=>|\|->|>=|\/=|<->|->|<-|<=>)/g, (match) => {
            ops.push(match);
            return opMarker + (ops.length - 1) + opMarker;
        });

        // Protect function calls
        const funcMarker = "§FUNC§";
        const funcs: string[] = [];
        text = text.replace(/\b(\w+)\(/g, (match, funcName) => {
            funcs.push(funcName);
            return funcMarker + (funcs.length - 1) + funcMarker + "(";
        });

        // Format logical operators
        text = text.replace(/\s*(&&|\|\|)\s*/g, " $1 ");
        text = text.replace(/\)\s*(and|or|xor|nand|nor|xnor)\s*\(/gi, ") $1 (");
        text = text.replace(/\s+\b(and|or|xor|nand|nor|xnor)\b\s+/gi, " $1 ");

        // Format simple equality operator
        text = text.replace(/\s*=\s*/g, " = ");

        // Format abort keyword
        text = text.replace(/\)\s*abort\s+/gi, ") abort ");

        // Format exclamation mark for eventually!
        text = text.replace(/\s*!\s*\{/g, "! {");

        // Clean up multiple spaces
        text = text.replace(/\s+/g, " ");

        // Format PSL keywords (lowercase)
        text = this.formatPSLKeywords(text);

        // semicolons
        text = text.replace(/\s*;\s*/g, ";");

        // braces - space before opening, no space inside
        text = text.replace(/\s*\{\s*/g, " {");
        text = text.replace(/\s*\}\s*/g, "}");

        // parentheses - no spaces inside
        text = text.replace(/\(\s+/g, "(");
        text = text.replace(/\s+\)/g, ")");

        // Restore function calls without space
        text = text.replace(
            new RegExp(funcMarker + "(\\d+)" + funcMarker, "g"),
            (_, index) => {
                return funcs[parseInt(index)];
            }
        );

        // Restore protected operators with proper spacing
        text = text.replace(
            new RegExp(opMarker + "(\\d+)" + opMarker, "g"),
            (_, index) => {
                return " " + ops[parseInt(index)] + " ";
            }
        );

        // Clean up any double spaces created by restoration
        text = text.replace(/\s+/g, " ");

        return text.trim();
    }

    private formatPSLKeywords(text: string): string {
        const pslKeywords = [
            "assert",
            "assume",
            "cover",
            "restrict",
            "fairness",
            "strong",
            "property",
            "sequence",
            "always",
            "never",
            "eventually",
            "next",
            "next_a",
            "next_e",
            "next_event",
            "until",
            "until_",
            "before",
            "before_",
            "abort",
            "sync_abort",
            "async_abort",
            "default",
            "clock",
            "is",
            "vmode",
            "vprop",
            "vunit",
            "stable",
            "and",
            "or",
            "not",
            "xor",
            "nand",
            "nor",
            "xnor",
        ];

        pslKeywords.forEach((keyword) => {
            const regex = new RegExp(`\\b${keyword}\\b`, "gi");
            text = text.replace(regex, keyword);
        });

        return text;
    }

    private isComment(text: string): boolean {
        return text.startsWith("--") || text.startsWith("/*");
    }

    private isAssertion(text: string): boolean {
        return /^\w+\s*:\s*(assert|assume|cover|restrict)\b/i.test(text);
    }

    private isPropertyStart(text: string): boolean {
        return /\b(property|sequence)\s+\w+\s+is\s*$/i.test(text);
    }

    private isPropertyEnd(text: string): boolean {
        return /;\s*$/.test(text);
    }

    private isVunitStart(text: string): boolean {
        return /\b(vunit|vmode|vprop)\b.*\{/i.test(text);
    }

    private shouldIncreaseIndentAfter(text: string): boolean {
        const increasePatterns = [
            /\b(property|sequence)\s+\w+\s+is\s*$/i,
            /\b(vunit|vmode|vprop)\b.*\{/i,
            /\bif\b.*\bthen\s*$/i,
            /\bcase\b.*\bis\s*$/i,
            /\bbegin\b/i,
        ];
        return increasePatterns.some((pattern) => pattern.test(text));
    }

    private shouldDecreaseIndentBefore(text: string): boolean {
        const decreasePatterns = [/^\s*\}/];
        return decreasePatterns.some((pattern) => pattern.test(text));
    }
}