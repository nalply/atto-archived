// Inspired by leac by KillyMXI <killy@mxii.eu.org> (MIT license)

import { createPosQuery } from './pos.ts'

/// The compiled lexer with tokenizer builder, specs, rules and debug flag
export type Lexer = {
  readonly tokenizerBuilder: TokenizerBuilder
  readonly specs: Specs
  readonly rules: Rules
  dbg: boolean
}

export type TokenizerBuilder = (s: string, dbg?: boolean) => Tokenizer

/// The tokenizer is an iterable with an additional nextToken() method
export type Tokenizer = Iterable<Token> & { nextToken(): Token }
 
export type Token = {
  readonly name: string
  /// Name of the rule group the token got tokenized in
  readonly group: string
  readonly text: string
  readonly offset: number
  readonly line: number
  readonly column: number
}

/// Compiled rules, structured in named rule groups. A text is matched only
/// by rules in the active rule group, one after another. If a rule's push
/// field is non-null, push and switch to the other rule group. If a rule's
/// pop field is true, return to the previous rule group.
export type Rules = Record<string, Rule[]>

/// Compiled rule created by [compileLexer]
export type Rule = {

  /// Name of the compiled rule, same as in the rule specification
  readonly name: string 

  /// Compiled regex for the rule
  readonly rx: RegExp

  /// A function called when `rx` matched
  readonly action: Action

  /// Name of the rule group the rule belongs to
  readonly group: string

  /// If non-null, push a different rule group
  readonly push: string | null

  /// If true, pop the rule group, i.e. return to the previous rule group
  readonly pop: boolean
}

/// The final token, after that [LexEndedError] is thrown
export type TokenFINAL = Token & { name: 'FINAL' }

/// Rule specifications, structured in named rule groups
export type Specs = Record<string, Spec[]>

/// A spec is an array in different forms compilable to a rule
export type Spec
  = StringSpec | StringPopSpec | StringPushSpec 
  | RegExpSpec | RegExpPopSpec | RegExpPushSpec


/// An action is a function taking a token and returning a token or null. If
/// the action returns null, the rule is skipped.
export type Action = (token: Token) => Token | null

/// A spec to match the string verbatim, that string is the rule's name
export type StringSpec = [ string, Action? ]

export type StringPopSpec = [ string, Pop, Action? ]

type StringPushSpec = [ string, string, Action? ]

/// A spec with a name and 
type RegExpSpec = [ string, RegExp, Action? ]
type RegExpPopSpec = [ string, RegExp, Pop, Action? ]
type RegExpPushSpec = [ string, RegExp, string, Action? ]

// todo StringPopPushSpec and RegExpPopPushSpec

export const POP = Symbol('POP')
type Pop = typeof POP

/// LexErrors are compile errors like push group not found
export class LexError extends Error {
  constructor(message: string) { super(message) }
}

/// LexEndedErrors are thrown after the FINAL token
export class LexEndedError extends Error {
  constructor() { super("no more tokens available") }
}

/// InternalErrors are bugs
export class InternalError extends Error {
  constructor(message: string) { super(message) }
}

/// Rule for unexpected text
const INVALID: Rule = Object.freeze({
  name: "INVALID",
  rx: /.+/vy,
  action: specAction(), // identity
  group: "ALL",
  push: null,
  pop: true,
})

// todo pass several chunks
// Idea: use a sentinel object to indicate end of text
// and pass repeatedly into the tokenizer
// each chunk can produce zero to many token

export function compileLexer(specs: Specs, opt: boolean = false): Lexer {
  const { rules, ruleGroupAll } = buildRules(specs)

  const start: string = Object.keys(rules)[0]
    ?? (() => { throw new LexError("empty spec") })()

  let dbg = opt ? dbgEnabled : dbgDisabled
  dbg("start group", start, "groups", Object.keys(rules))

  const groups = Object.values(rules)
  const count = groups.reduce((prev, curr) => prev + curr.length, 0)
  dbg("total count of rules", count)
    
  return {
    get tokenizerBuilder() { return tokenizerBuilder },
    get specs() { return specs },
    get rules() { return rules },
    get dbg() { return dbg === dbgEnabled },
    set dbg(opt) { opt ? dbgEnabled: dbgDisabled },
  }

  function tokenizerBuilder(s: string, opt: boolean = false) {
    dbg = opt ? dbgEnabled : dbgDisabled
          
    const tokenGenerator = lex(s, [ start ])
    return {
      nextToken: (): Token => {
        const result = tokenGenerator.next()
        if (result.done) throw new LexEndedError()
        return result.value
      },
      [Symbol.iterator]: () => tokenGenerator,
    }
  }

  function* lex(s: string, stack: string[]): Generator<Token> {
    let offset = 0
    const posQuery = createPosQuery(s)

    function makeToken(
      data: { group: string, name: string },
      text: string,
      offset: number,
    ) {
      return Object.freeze({ ...data, offset, text, ...posQuery(offset) })
    }
    
    while (offset < s.length) {
      dbg("stack", stack.join(" "))
      
      const currLexer = stack[0]
      if (currLexer == null) {
        dbg("lexer is empty")
        break
      }

      const curr = rules[currLexer]
      assertDefined(curr)
      const ruleGroup = [ ...curr, ...ruleGroupAll ]
      dbg(currLexer, "rules:", ruleGroup.map(rule => rule.name).join(" "))

      for (const rule of ruleGroup) {
        rule.rx.lastIndex = offset;
        const match = rule.rx.exec(s)
        if (!match || match[0] === "") continue
        dbg("  match", id(rule), "`" + strEsc(match[0]) + "`", offset)
                
        const token = rule.action(makeToken(rule, match[0], offset))
        dbg("  action", token, offset)
        if (token === null) continue

        offset = rule.rx.lastIndex
        dbg("  yield", currLexer + "/" + token.name, offset)
        yield token
      

        if (rule.pop) {
          const popped = stack.shift()
          dbg("  popped", popped, "off", stack)
        }
      
        if (rule.push) {
          stack.unshift(rule.push)
          dbg("  push", stack.join(" "))
        }

        break
      }
    }

    const token = makeToken({ group: 'FINAL', name: 'FINAL' }, '', offset)
    dbg("final yield")
    yield token
  }
  
}

function buildRules(specs: Specs): { rules: Rules, ruleGroupAll: Rule[] } {
  const ruleGroupAll: Rule[] = []
  const rules: Rules = {}
  for (const [ name, specGroup ] of Object.entries(specs)) {
    const ruleGroup: Rule[] = name === 'ALL' ? ruleGroupAll : []
    rules[name] = ruleGroup

    for (const spec of specGroup) ruleGroup.push(buildRule(spec, name))
  }

  ruleGroupAll.push(INVALID)

  // check that all push strings refer an existing group todo sometimes fails
  for (const ruleGroup of Object.values(rules)) {
    for (const rule of ruleGroup) {
      if (rule.push === null) continue

      if (rules[rule.push] == null)
        throw new LexError(`no push '${rule.push}' found for ${id(rule)}`)
    }
  }

  // freeze everything including ruleGroupAll 
  Object.freeze(rules)
  for (const rule of Object.values(rules)) Object.freeze(rule)
  Object.freeze(specs)
  for (const spec of Object.values(specs)) Object.freeze(spec)
   
  return { rules, ruleGroupAll }
}

function specPop(spec: Spec): boolean {
  return spec[1] === POP || spec[2] === POP
}

function specPush(spec: Spec): string | null {
  return typeof spec[1] === "string" ? spec[1]
    : typeof spec[2] === "string" ? spec[2]
    : null
}

function specAction(spec?: Spec): Action {
  const identityAction = (token: Token) => token
  
  return spec?.filter(el => typeof el === "function")[0] as Action
     ?? identityAction
}

function buildRule(rule: Spec, group: string): Rule {
  const name = rule[0]
  const pop = specPop(rule)
  const push = specPush(rule)
  const action = specAction(rule)
  const rx = asRx(rule[1]) || toRx(rule[0])

  if (rx.toString().endsWith("/vy"))
    return Object.freeze({ name, group, pop, push, action, rx })

  throw new LexError(`invald regex flags for ${id({ group, name })}`) 
}

function dbgEnabled(...args: any[]) {
  console.debug(...args)
}

function dbgDisabled(..._: any[]) {
} 

function rxEsc(str: string) {
  return str.replace(/[-[\]{}()*+!<=?./\\^$|#\s,]/g, '\\$&')
}

type EscOpt = "backslash" | "guillemet"

export function strEsc(s: string, opt: EscOpt = "backslash") {
  const c1 = opt === "backslash" ? "\\u{" : "‹"
  const c2 = opt === "backslash" ? "}" : "›"
  const cp = (c: string) => c.codePointAt(0) ?? 0xfffd
  const esc = (c: string) => 
    c1 + cp(c).toString(16).padStart(2, "0") + c2
   
  return s.replace(/[[\p{C}\p{Z}]--[" "]]/gv, esc)
}

function id(id: { group: string, name: string }): string {
  return id.name + " in " + id.group
}

function toRx(rx: string): RegExp {
  return new RegExp(rxEsc(rx), "vy")
}

function asRx(rx: any): RegExp | false {
  return rx?.constructor === RegExp ? rx : false
}

function assertDefined<T>(value: T | undefined | null): asserts value is T {
  if (value == null)
    throw new InternalError("assertion failed: value not defined")
}

// Copyright see AUTHORS; see LICENSE; SPDX-License-Identifier: ISC+
