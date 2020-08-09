import fs from 'fs';
import path from 'path';
import { camelCase, upperFirst } from 'lodash';
import { request } from 'http';

function getJsonFile(filePath: string): any {
  const p = path.join(__dirname, filePath);
  const buffer = fs.readFileSync(p, 'utf8');
  return JSON.parse(buffer);
}

class Imports {
  imports: Map<string, Set<string>> = new Map();

  add(value: string, from: string) {
    const set = this.imports.get(from);
    if (!set) {
      this.imports.set(from, new Set());
    }
    set?.add(value);
  }

  get(): string[] {
    const multipleImports: string[] = []
    // const importsArray: string[] = [];
    for (const [from, values] of this.imports.entries()) {
      const valuesStr = Array.from(values).join(', ');
      multipleImports.push(`import {${values}} from ${from};`);
    }
    return multipleImports;
  }
}

// top and bottom are going to be the same
// imports and exports
class GFile {
  name: string;

  exports: string[] = [];
  imports: Imports = new Imports();

  classes: GClass[] = [];

  parts: GPart[] = [];

  constructor(name: string) {
    this.name = name;
  }

  createClass(name: string): GClass {
    const gClass = new GClass(name, this.imports);
    this.classes.push(gClass);
    return gClass;
  }

  save(directory: string, extention: string) {
    const p = path.join(__dirname, directory);
    fs.writeFileSync(p, `${this.name}${extention}`);
  }
}

class GPart {
  stringRepresentation: string = '';
  imports: Imports;
  name: string;

  constructor(name: string, imports: Imports) {
    this.name = name;
    this.imports = imports;
  }

  getImports() {
    return this.imports;
  }

  toString() {
    return this.stringRepresentation;
  }
}

const TYPES = {
  string: 'string',
  array: 'array',
  number: 'number',
  integer: 'integer',
  boolean: 'boolean',
  file: 'file',
  object: 'object',
}

function getType(value: any, imports: Imports): string {
  let convertedType = '';
  const type = value?.type;
  if (type) {
    switch (type) {
      case TYPES.string:
      case TYPES.boolean:
        convertedType = type;
        break;
      case TYPES.number:
      case TYPES.integer:
        convertedType = TYPES.number;
        break;
      case TYPES.file:
        convertedType = 'FormData'
        break;
      case TYPES.array:
        convertedType = `${getType(value.items, imports)}[]`;
        break;
      case TYPES.object:
        const additionalProperties = value?.additionalProperties;

        if (additionalProperties) {
          convertedType = getType(value.additionalProperties, imports);
        } else {
          convertedType = 'any';
        }
        break;
    }
  } else if (value?.schema) {
    convertedType = getType(value.schema, imports);
  }

  if (convertedType !== '') {
    return convertedType;
  } else {
    const ref = value?.$ref;
    if (ref) {
      const matches = /^#\/definitions\/(.+)/.exec(ref);
      if (matches && matches[1]) {
        // const pageMatches = /((Page|PaginationResponse)«(.+)»)|(.+)/.exec(matches[1]);
        const pageMatches = matches[1].match(/((Page|PaginationResponse)«(.+)»)|(.+)/);
        if (pageMatches) {
          convertedType = pageMatches[1];
          console.log(pageMatches);
          if (convertedType === undefined) {
            console.error(convertedType);
            console.error('Could not convert PAGE');
          }
          imports.add(convertedType, '@private/repository')
        } else {
          console.error('could not parse dtos');
        }
      } else {
        console.error('could not parse dtos');
      }
    }

    if (convertedType === '') {
      console.error('this type does not exist');
      console.error(value);
      return '';
    }
  }
  return convertedType;
}

class Argument {
  name: string;
  type: string;
  required: boolean;
  default: string;
  imports: Imports;

  constructor(value: any, imports: Imports) {
    this.name = value.name;
    this.type = getType(value, imports);
    this.required = value.required;
    this.default = value?.default ? value.default : undefined;
    this.imports = imports;
  }

  toString(): string {
    if (this.required) {
      return `${this.name}: ${this.type}`
    }
    return `${this.name}: ${this.type}`
    // return `${this.name}: ${this.type} = ${this.default}`
  }
}

class GMethod extends GPart {
  arguments: Argument[] = [];
  returnValue: string = ''
  returnType: string = ''
  insideLines: string[] = [];

  constructor(name: string, imports: Imports) {
    super(name, imports);
  }

  static newService(data: any, imports: Imports): GMethod {
    const gMethod = new GMethod(data.summary, imports);

    const parameters = data?.parameters ? (data.parameters as any[]) : [];
    if (parameters.length > 0) {
      parameters.forEach(parameter => {
        const arg = gMethod.addArgument(parameter);
      })
    }

    const matches = /(.+)Using.+$/.exec(data.operationId);
    if (matches && matches[1]) {
      gMethod.name = matches[1];
    } else {
      console.error('Could not find method name');
    }

    const schema = data.responses["200"]?.schema;
    if (schema) {
      gMethod.returnType = getType(schema, gMethod.imports);
    } else {
      gMethod.returnType = 'void';
    }
    // console.log(gMethod.returnType);
    return gMethod;
  }

  addArgument(data: any) {
    const arg = new Argument(data, this.imports);
    this.arguments.push(arg);
    return arg;
  }

  toString(): string {
    return `
      ${this.name}(${this.arguments.join(', ')}): ${this.returnType} {
        ${this.insideLines.join(';\n')}
        return ${this.returnValue};
      }
    `
  }
}

class GClass extends GPart {
  methods: GMethod[] = [];
  // fields: GField[];

  constructor(name: string, imports: Imports) {
    super(name, imports)
  }

  addMethod(name: string) {
    const gMethod = new GMethod(name, this.imports);
    this.methods.push(gMethod);
    return gMethod;
  }

  addServiceMethod(data: any) {
    const gMethod = GMethod.newService(data, this.imports);
    this.methods.push(gMethod);
    return gMethod;
  }
}

function generateServices() {
  const controllerMap = new Map<string, GFile>()
  const controllers = getJsonFile('file.json').paths as any;
  for (const [controllerName, controllerInside] of Object.entries<any>(controllers)) {
    for (const [requestType, requestInside] of Object.entries<any>(controllerInside)) {
      let file = controllerMap.get(controllerName);
      if (file === undefined) {
        const fileName = camelCase(requestInside.tags[0]);
        file = new GFile(fileName);
        controllerMap.set(controllerName, file);

        const className = upperFirst(fileName);
        file.createClass(className);
      }
      const gClass = file.classes[0];

      const gMethod = gClass.addServiceMethod(requestInside);
      // const parameters = (requestInside?.parameters as any[]);
      // if (parameters) {
      //   parameters.forEach(parameter => {
      //     console.log(parameter);
      //   })
      // }
    }
    // break;
  }
}

generateServices();
