# Geo GraphQL — what the pipeline actually uses

Endpoint: `https://api-testnet.geobrowser.io/graphql` (override with
`GEO_GRAPHQL_URL`). Read-only, unauthenticated, no rate limit observed.

Distilled from `GEO_API_SCHEMA.json` (182 types) and verified against the live
API. Everything below has been run.

## The data model in one paragraph

Everything is an **Entity**. A type is an entity (of type `Type`); a property is
an entity that also has a `PropertyInfo` row; a space's page is an entity. Facts
hang off an entity as **Values** (scalars, each pointing at a property) and
**Relations** (edges to other entities, each with a type). So "give me the
entity" plus "give me its values and relations" answers almost every question.

## Ids

32 lowercase hex characters, no dashes — `0068f0fc16034c749c991e6eabe37031`.
The API also accepts dashed UUIDs; `normalizeGeoId()` converts and validates.

## Well-known ids (verified)

| Constant | Id | Note |
|---|---|---|
| `NAME` | `a126ca530c8e48d5b88882c734c38935` | value property |
| `DESCRIPTION` | `9b1f76ff9711404c861e59dc3fa7d037` | value property |
| `AVATAR` | `1155befffad549b7a2e0da4777b8792c` | relation → image entity |
| `COVER` | `34f535072e6b42c5a84443981a77cfa2` | relation → image entity |
| `IPFS_URL` | `8a743832c0944a62b6650c3cc2f9c7bc` | value on the image entity |
| `TYPES_REL` | `8f151ba4de204e3c9cb499ddf96f48f1` | entity → its types |
| `PROPERTIES_REL` | `01412f8381894ab1836565c7fd358cc1` | type → its properties |
| `BLOCKS_REL` | `beaba5cba67741a8b35377030613fc70` | page layout, **noise** |
| `TYPE_TYPE` | `e7d737c536764c609fa16aa64a8c90ad` | the type of types |
| `PERSON_TYPE` | `7ed45f2bc48b419e8e4664d5ff680b0d` | |

`npm run check:live` re-verifies these against the API.

## Queries

Argument nullability matters — GraphQL rejects a nullable variable passed to a
`!` argument:

```
entity(id: UUID!)        relation(id: UUID!)     space(id: UUID!)
property(id: UUID)       type(id: UUID)          typesList(spaceId: UUID, …)
properties(spaceId: UUID, first: Int, filter: PropertyInfoFilter)
search(query: String, spaceId: UUID, similarityThreshold: Float, first: Int)
entities(spaceId: UUID, typeId: UUID, filter: EntityFilter, first: Int, …)
```

### One entity, everything about it

```graphql
query($id:UUID!){
  entity(id:$id){
    id name description spaceIds
    types(first:8){ id name }
    valuesList(first:60){
      propertyId text boolean decimal integer float date datetime unit
      property{ name dataTypeName renderableTypeName }
    }
    relationsList(first:80){ typeId type{ name } toEntity{ id name } }
  }
}
```

`types` can repeat the same type once per space — de-duplicate. `toEntity.name`
is often `null` (layout blocks); drop those.

### Its own picture

```graphql
query($id:UUID!){
  entity(id:$id){
    relationsList(first:12, filter:{typeId:{in:["<AVATAR>","<COVER>"]}}){
      typeId
      toEntity{ valuesList(first:6, filter:{propertyId:{is:"<IPFS_URL>"}}){ text } }
    }
  }
}
```

Two hops: the Avatar relation points at an *image entity*, whose IPFS URL value
holds `ipfs://<cid>`.

### Search by name

```graphql
query($q:String,$space:UUID,$first:Int){
  search(query:$q, spaceId:$space, first:$first){
    id name description spaceIds types(first:6){ id name }
  }
}
```

Returns a summary only — re-read the winner with `entity(id:)` for facts.

### Types and properties

```graphql
typesList(first:8, spaceId:$space, filter:{name:{includesInsensitive:$q}}){ id name description }
property(id:$id){ id name description dataTypeName renderableTypeName format isType }
properties(first:8, filter:{name:{includesInsensitive:$q}}){ … }
```

`typesList`'s `spaceId` argument does **not** appear to filter — treat results
as global.

A type's schema is its `PROPERTIES_REL` relations:

```graphql
entity(id:$id){ relationsList(first:40, filter:{typeId:{is:"<PROPERTIES_REL>"}}){ toEntity{ name } } }
```

### Spaces

```graphql
space(id:$id){ id type address page{ id name description } }   # type: DAO | PERSONAL
```

`page` carries the human name and description, and is often `null`. The entity
sharing the space's id is a system row whose description reads
`"System entity for space <uuid>"` — a placeholder, not a description.

**Performance trap:** `entities(spaceId:…)` costs about **one second per row**
and returns `"Unexpected error."` past roughly 30 rows. `filter:{spaceIds:
{anyEqualTo:…}}` is no faster. Sample 15 rows at most, and only when there is no
description to work from.

### Relations

```graphql
relation(id:$id){
  id typeId spaceId verified
  type{ name description }
  fromEntity{ id name description types(first:5){ id name } }
  toEntity{ id name description types(first:5){ id name } }
}
```

## Filters

`UUIDListFilter` (for `typeIds`, `spaceIds`) has **no** `contains` — use
`anyEqualTo`, `overlaps`, `containedBy`, `in`. `StringFilter` has the useful
`includesInsensitive`, `startsWithInsensitive`, `isInsensitive`. Nested
collections take `{some: …}` / `{every: …}` / `{none: …}`:

```graphql
entities(first:8, filter:{
  typeIds:{anyEqualTo:"<PERSON_TYPE>"},
  relations:{some:{typeId:{is:"<AVATAR>"}}}
}){ id name }
```

## Errors

A GraphQL error arrives as HTTP 200 with an `errors` array — check for it, not
just the status. `gql()` in `src/geo.ts` normalises: HTTP failure, non-JSON body,
`errors[]`, and a null `data` all become one `GeoError`.
