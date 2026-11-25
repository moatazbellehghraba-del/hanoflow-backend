import { buildSchema, parse, validate } from 'graphql';
import { queryLimits } from './query-limits.js';

const schema = buildSchema(
  'type Query { node: Node! } type Node { child: Node value: String }',
);
describe('GraphQL operation bounds', () => {
  it('allows a small operational query', () => {
    expect(
      validate(schema, parse('{ node { value } }'), [queryLimits]),
    ).toEqual([]);
  });
  it('counts fields through aliased fragment expansion', () => {
    const aliases = Array.from(
      { length: 501 },
      (_, i) => 'a' + String(i) + ': value',
    ).join(' ');
    const errors = validate(
      schema,
      parse(
        '{ node { ...Fields } } fragment Fields on Node { ' + aliases + ' }',
      ),
      [queryLimits],
    );
    expect(errors[0]?.extensions.code).toBe('QUERY_LIMIT_EXCEEDED');
  });
  it('counts depth through fragments and inline fragments', () => {
    const nested = 'child { '.repeat(20) + 'value' + ' }'.repeat(20);
    expect(
      validate(
        schema,
        parse(
          '{ node { ...Deep } } fragment Deep on Node { ... on Node { ' +
            nested +
            ' } }',
        ),
        [queryLimits],
      )[0]?.extensions.code,
    ).toBe('QUERY_LIMIT_EXCEEDED');
  });
  it('terminates when a document contains a fragment cycle', () => {
    expect(() =>
      validate(
        schema,
        parse(
          '{ node { ...Cycle } } fragment Cycle on Node { child { ...Cycle } }',
        ),
        [queryLimits],
      ),
    ).not.toThrow();
    // Standard GraphQL validation (enabled by Apollo) rejects the cycle itself.
  });
});
