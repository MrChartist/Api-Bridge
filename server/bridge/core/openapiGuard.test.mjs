/**
 * The versioning promise (docs/guides/developers.md): under /v1 a route, a parameter, a response field or a code is not
 * removed or renamed, and a request or response does not change shape unnoticed.
 *
 * This compares docs/openapi.yaml with a committed snapshot of the contract (server/bridge/core/__fixtures__/openapi-contract.jsonl:
 * per operation the operationId, scope, parameters, request body and 2xx responses; per schema its required fields; see
 * openapiContract.mjs). Adding things (a route, an optional parameter, a new schema) passes. Removing or narrowing anything
 * that was there, or changing a required list, fails with a sentence that says what.
 *
 * If a change is meant (and written in the CHANGELOG), refresh the snapshot and commit it with the change:
 *   UPDATE_OPENAPI_CONTRACT=1 npx vitest run server/bridge/core/openapiGuard.test.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { breakingChanges, extractContract, parseBaseline, renderContract } from "./openapiContract.mjs";

const SPEC_FILE = resolve(import.meta.dirname, "../../../docs/openapi.yaml");
const BASELINE_FILE = resolve(import.meta.dirname, "__fixtures__/openapi-contract.jsonl");
const spec = readFileSync(SPEC_FILE, "utf8");

describe("the OpenAPI contract is only ever added to", () => {
  it("matches the committed snapshot (nothing removed, renamed or narrowed)", () => {
    const current = extractContract(spec);
    if (process.env.UPDATE_OPENAPI_CONTRACT === "1") {
      writeFileSync(BASELINE_FILE, renderContract(current));
      return;
    }
    const changes = breakingChanges(parseBaseline(readFileSync(BASELINE_FILE, "utf8")), current);
    expect(changes, `${changes.length} contract change(s). If they are meant, note them in the CHANGELOG and run: UPDATE_OPENAPI_CONTRACT=1 npx vitest run server/bridge/core/openapiGuard.test.mjs`).toEqual([]);
  });

  it("records a real number of operations, parameters and required fields (the reader still reads the spec)", () => {
    const { operations, schemas } = extractContract(spec);
    expect(operations.size).toBeGreaterThan(200);
    expect([...operations.values()].filter((o) => o.operationId).length).toBeGreaterThan(200);
    expect([...operations.values()].filter((o) => o.params.length).length).toBeGreaterThan(60);
    expect([...operations.values()].filter((o) => o.body?.schemas.length).length).toBeGreaterThan(30);
    expect([...schemas.values()].filter(Boolean).length).toBeGreaterThan(50);
    const dl = operations.get("POST /v1/downloads");
    expect(dl).toMatchObject({ operationId: "createDownload", scope: "read" });
    expect(dl.body.required).toBe(true);
    expect(schemas.get("DownloadRequest")).toBe("from,intervals");
  });
});

describe("the guard catches what the promise forbids", () => {
  const SPEC_A = `paths:
  /v1/things:
    get:
      operationId: listThings
      x-scope: read
      parameters:
        - name: limit
          in: query
          schema: { type: integer }
        - { name: kind, in: query, required: false, schema: { type: string } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { type: array, items: { $ref: "#/components/schemas/Thing" } }
    post:
      operationId: makeThing
      x-scope: paper
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ThingRequest" }
      responses:
        "201":
          description: made
  /v1/things/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    get:
      operationId: getThing
      x-scope: read
components:
  schemas:
    Thing:
      type: object
      required: [id, name]
    ThingRequest:
      type: object
      required: [name]
`;
  const base = parseBaseline(renderContract(extractContract(SPEC_A)));

  it("reads the shapes it records", () => {
    const c = extractContract(SPEC_A);
    expect(c.operations.get("GET /v1/things")).toMatchObject({ operationId: "listThings", scope: "read", params: ["limit:query", "kind:query"] });
    expect(c.operations.get("GET /v1/things/{id}").params).toEqual(["id:path!"]);
    expect(c.operations.get("POST /v1/things").body).toEqual({ required: true, schemas: ["ThingRequest"], requiredLists: [] });
    expect(c.operations.get("GET /v1/things").responses["200"]).toEqual({ schemas: ["Thing"], requiredLists: ["data,meta"] });
    expect(c.schemas.get("Thing")).toBe("id,name");
  });

  it("passes for an unchanged spec and for additions", () => {
    expect(breakingChanges(base, extractContract(SPEC_A))).toEqual([]);
    const added = SPEC_A.replace("        - { name: kind,", "        - { name: extra, in: query, schema: { type: string } }\n        - { name: kind,") + "  /v1/more:\n    get:\n      operationId: more\n      x-scope: read\n";
    expect(breakingChanges(base, extractContract(added))).toEqual([]);
  });

  it("fails when a route, an operationId or a scope goes or changes", () => {
    expect(breakingChanges(base, extractContract(SPEC_A.replace("/v1/things/{id}:", "/v1/thing/{id}:")))).toContain("GET /v1/things/{id}: the route is gone (or its path or method changed)");
    expect(breakingChanges(base, extractContract(SPEC_A.replace("listThings", "listAllThings")))).toContain("GET /v1/things: operationId listThings is now listAllThings");
    expect(breakingChanges(base, extractContract(SPEC_A.replace("x-scope: paper", "x-scope: live")))).toContain("POST /v1/things: scope paper is now live");
  });

  it("fails when a parameter is removed or becomes required, or a new required one appears", () => {
    const noLimit = SPEC_A.replace("        - name: limit\n          in: query\n          schema: { type: integer }\n", "");
    expect(breakingChanges(base, extractContract(noLimit))).toContain("GET /v1/things: parameter limit:query was removed");
    expect(breakingChanges(base, extractContract(SPEC_A.replace("name: kind, in: query, required: false", "name: kind, in: query, required: true")))).toContain("GET /v1/things: parameter kind:query is now required");
    const newRequired = SPEC_A.replace("        - { name: kind,", "        - { name: must, in: query, required: true, schema: { type: string } }\n        - { name: kind,");
    expect(breakingChanges(base, extractContract(newRequired))).toContain("GET /v1/things: a new parameter must:query is required");
  });

  it("fails when a request or response schema changes shape", () => {
    expect(breakingChanges(base, extractContract(SPEC_A.replace("required: [data, meta]", "required: [data]")))[0]).toMatch(/^GET \/v1\/things: the 200 response's required fields changed/);
    expect(breakingChanges(base, extractContract(SPEC_A.replace("required: [name]", "required: [name, kind]")))).toContain("schema ThingRequest: required fields changed (name -> kind,name)");
    expect(breakingChanges(base, extractContract(SPEC_A.replace('schema: { $ref: "#/components/schemas/ThingRequest" }', "schema: { type: object }")))).toContain("POST /v1/things: the request no longer uses schema ThingRequest");
    expect(breakingChanges(base, extractContract(SPEC_A.replace("    Thing:\n", "    Gone:\n")))).toContain("schema Thing: removed");
  });
});
