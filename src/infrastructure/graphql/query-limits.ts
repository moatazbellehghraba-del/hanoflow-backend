import { GraphQLError, Kind } from 'graphql';
import type { SelectionSetNode, ValidationRule } from 'graphql';

// Coarse infrastructure ceilings, not resolver-cost authorization. The standard
// development introspection query uses depth 15 / 220 expanded fields, so these
// allow normal tooling. Review with the first real schema; count every use.
export const queryLimits: ValidationRule = (context) => ({
  OperationDefinition(operation) {
    let fields = 0;
    let exceeded = false;
    const visit = (
      set: SelectionSetNode,
      depth: number,
      fragments: Set<string>,
    ): void => {
      for (const selection of set.selections) {
        if (exceeded) return;
        if (selection.kind === Kind.FIELD) {
          fields++;
          if (depth + 1 > 20 || fields > 500) {
            exceeded = true;
            return;
          }
          if (selection.selectionSet)
            visit(selection.selectionSet, depth + 1, fragments);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          visit(selection.selectionSet, depth, fragments);
        } else if (!fragments.has(selection.name.value)) {
          const fragment = context.getFragment(selection.name.value);
          if (fragment)
            visit(
              fragment.selectionSet,
              depth,
              new Set([...fragments, selection.name.value]),
            );
        }
      }
    };
    visit(operation.selectionSet, 0, new Set());
    if (exceeded)
      context.reportError(
        new GraphQLError('Query exceeds supported limits', {
          extensions: { code: 'QUERY_LIMIT_EXCEEDED' },
        }),
      );
  },
});
