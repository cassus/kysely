import { QueryBuilder } from '../query-builder/query-builder'
import {
  DeleteResultTypeTag,
  InsertResultTypeTag,
  UpdateResultTypeTag,
} from '../query-builder/type-utils'
import { SelectResultType } from './select-parser'

/**
 * `returning` method output query builder type
 */
export type QueryBuilderWithReturning<
  DB,
  TB extends keyof DB,
  O,
  S
> = QueryBuilder<
  DB,
  TB,
  O extends InsertResultTypeTag
    ? SelectResultType<DB, TB, S>
    : O extends DeleteResultTypeTag
    ? SelectResultType<DB, TB, S>
    : O extends UpdateResultTypeTag
    ? SelectResultType<DB, TB, S>
    : O
>
