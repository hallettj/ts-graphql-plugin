import ts from 'typescript';
import { GraphQLSchema } from 'graphql';
import { CompletionItem, Diagnostic, Position } from 'graphql-language-service-types';
import { getAutocompleteSuggestions, getDiagnostics, getHoverInformation } from 'graphql-language-service-interface';

import { isTagged, TagCondition, ResolveTemplateExpressionResult } from '../ts-util';

export interface GraphQLLanguageServiceAdapterCreateOptions {
  schema?: GraphQLSchema | null;
  logger?: (msg: string) => void;
  tag?: string;
}

export interface ScriptSourceHelper {
  getAllNodes: (fileName: string, condition: (n: ts.Node) => boolean) => ts.Node[];
  getNode: (fileName: string, position: number) => ts.Node | undefined;
  getLineAndChar: (fileName: string, position: number) => ts.LineAndCharacter;
  resolveTemplateLiteral: (
    fileName: string,
    node: ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression,
  ) => ResolveTemplateExpressionResult | undefined;
}

type GetCompletionAtPosition = ts.LanguageService['getCompletionsAtPosition'];
type GetSemanticDiagnostics = ts.LanguageService['getSemanticDiagnostics'];
type GetQuickInfoAtPosition = ts.LanguageService['getQuickInfoAtPosition'];

function translateCompletionItems(items: CompletionItem[]): ts.CompletionInfo {
  const result: ts.CompletionInfo = {
    isGlobalCompletion: false,
    isMemberCompletion: false,
    isNewIdentifierLocation: false,
    entries: items.map(r => {
      // FIXME use ts.ScriptElementKind
      const kind = r.kind ? r.kind + '' : ('unknown' as any);
      return {
        name: r.label,
        kindModifiers: 'declare',
        kind,
        sortText: '0',
      };
    }),
  };
  return result;
}

function translateDiagnostic(d: Diagnostic, file: ts.SourceFile, start: number, length: number): ts.Diagnostic {
  const code = typeof d.code === 'number' ? d.code : 9999;
  const messageText = d.message.split('\n')[0];
  return {
    code,
    messageText,
    category: d.severity as ts.DiagnosticCategory,
    file,
    start,
    length,
  };
}

class SimplePosition implements Position {
  line: number;
  character: number;

  constructor(lc: ts.LineAndCharacter) {
    this.line = lc.line;
    this.character = lc.character;
  }

  lessThanOrEqualTo(p: Position) {
    if (this.line < p.line) return true;
    if (this.line > p.line) return false;
    return this.character <= p.character;
  }
}

export class GraphQLLanguageServiceAdapter {
  private _schema?: GraphQLSchema;
  private _tagCondition?: TagCondition;

  constructor(private _helper: ScriptSourceHelper, opt: GraphQLLanguageServiceAdapterCreateOptions = {}) {
    if (opt.logger) this._logger = opt.logger;
    if (opt.schema) this.updateSchema(opt.schema);
    if (opt.tag) this._tagCondition = opt.tag;
  }

  updateSchema(schema: GraphQLSchema) {
    this._schema = schema;
  }

  getCompletionAtPosition(
    delegate: GetCompletionAtPosition,
    fileName: string,
    position: number,
    options?: ts.GetCompletionsAtPositionOptions,
  ) {
    if (!this._schema) return delegate(fileName, position, options);
    const node = this._findTemplateNode(fileName, position);
    if (!node) return delegate(fileName, position, options);
    const resolvedTemplateInfo = this._helper.resolveTemplateLiteral(fileName, node);
    if (!resolvedTemplateInfo) {
      return delegate(fileName, position, options);
    }
    const { combinedText, getInnerPosition, convertInnerPosition2InnerLocation } = resolvedTemplateInfo;
    // NOTE: The getAutocompleteSuggestions function does not return if missing '+1' shift
    const innerPositionToSearch = getInnerPosition(position).pos + 1;
    const innerLocation = convertInnerPosition2InnerLocation(innerPositionToSearch);
    this._logger('Search text: "' + combinedText + '" at ' + innerPositionToSearch + ' position');
    const positionForSeach = new SimplePosition({
      line: innerLocation.line,
      character: innerLocation.character,
    });
    const gqlCompletionItems = getAutocompleteSuggestions(this._schema, combinedText, positionForSeach);
    this._logger(JSON.stringify(gqlCompletionItems));
    return translateCompletionItems(gqlCompletionItems);
  }

  getSemanticDiagnostics(delegate: GetSemanticDiagnostics, fileName: string) {
    const errors = delegate(fileName) || [];
    if (!this._schema) return errors;
    const allTemplateStringNodes = this._helper.getAllNodes(
      fileName,
      (n: ts.Node) => ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n),
    );
    const nodes = allTemplateStringNodes.filter(n => {
      if (!this._tagCondition) return true;
      return isTagged(n, this._tagCondition);
    }) as ts.NoSubstitutionTemplateLiteral[];
    const diagnosticsAndResolvedInfoList = nodes.map(n => {
      const resolvedTemplateInfo = this._helper.resolveTemplateLiteral(fileName, n);
      if (!resolvedTemplateInfo) return;
      return {
        resolvedTemplateInfo,
        diagnostics: getDiagnostics(resolvedTemplateInfo.combinedText, this._schema),
      };
    });
    const result = [...errors];
    diagnosticsAndResolvedInfoList.forEach((info, i) => {
      const node = nodes[i];
      if (!info) {
        result.push({
          code: 9999,
          category: ts.DiagnosticCategory.Warning,
          messageText: 'This operation or fragment has too complex dynamic expression(s) to analize.',
          file: node.getSourceFile(),
          start: node.getStart(),
          length: node.getEnd() - node.getStart(),
        });
        return;
      }
      const {
        diagnostics,
        resolvedTemplateInfo: { getSourcePosition, convertInnerLocation2InnerPosition },
      } = info;
      diagnostics.forEach(d => {
        let length = 0;
        const { pos: startPositionOfSource, isInOtherExpression } = getSourcePosition(
          convertInnerLocation2InnerPosition(d.range.start),
        );
        try {
          const endPositionOfSource = getSourcePosition(convertInnerLocation2InnerPosition(d.range.end)).pos;
          length = endPositionOfSource - startPositionOfSource - 1;
        } catch (error) {
          length = 0;
        }
        if (isInOtherExpression) {
          result.push({
            code: 9999,
            category: ts.DiagnosticCategory.Error,
            messageText: 'This expression has some GraphQL errors.',
            file: node.getSourceFile(),
            start: startPositionOfSource,
            length,
          });
          return;
        } else {
          result.push(translateDiagnostic(d, node.getSourceFile(), startPositionOfSource, length));
        }
      });
    });
    return result;
  }

  getQuickInfoAtPosition(delegate: GetQuickInfoAtPosition, fileName: string, position: number) {
    if (!this._schema) return delegate(fileName, position);
    const node = this._findTemplateNode(fileName, position);
    if (!node) return delegate(fileName, position);
    const resolvedTemplateInfo = this._helper.resolveTemplateLiteral(fileName, node);
    if (!resolvedTemplateInfo) return delegate(fileName, position);
    const { combinedText, getInnerPosition, convertInnerPosition2InnerLocation } = resolvedTemplateInfo;
    const cursor = new SimplePosition(convertInnerPosition2InnerLocation(getInnerPosition(position).pos + 1));
    const result = getHoverInformation(this._schema, combinedText, cursor);
    if (typeof result !== 'string' || !result.length) return delegate(fileName, position);
    return {
      kind: ts.ScriptElementKind.string,
      textSpan: {
        start: position,
        length: 1,
      },
      kindModifiers: '',
      displayParts: [{ text: result, kind: '' }],
    } as ts.QuickInfo;
  }

  private _findTemplateNode(fileName: string, position: number) {
    const foundNode = this._helper.getNode(fileName, position);
    if (!foundNode) return;
    let node: ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression;
    if (ts.isNoSubstitutionTemplateLiteral(foundNode)) {
      node = foundNode;
    } else if (ts.isTemplateHead(foundNode)) {
      node = foundNode.parent;
    } else if (ts.isTemplateMiddle(foundNode) || ts.isTemplateTail(foundNode)) {
      node = foundNode.parent.parent;
    } else {
      return;
    }
    if (this._tagCondition && !isTagged(node, this._tagCondition)) {
      return;
    }
    return node;
  }

  private _logger: (msg: string) => void = () => {};
}