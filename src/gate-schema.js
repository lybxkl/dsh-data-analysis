/** Offline validator for the deliberately bounded JSON Schema dialect we ship. */
export function validateSchema(value, schema) {
  // format is an annotation in our shared 2020-12 dialect, as in Python's validator.
  const supported=new Set(['$schema','$id','$defs','$ref','title','description','format','type','const','enum','minLength','maxLength','pattern','minimum','maximum','exclusiveMinimum','minItems','uniqueItems','items','required','properties','additionalProperties','allOf','oneOf','anyOf','if','then','else']);
  function dialect(rule,depth=0){
    if(!rule||typeof rule!=='object'||Array.isArray(rule)||depth>64)throw Error('unsupported schema structure');
    for(const key of Object.keys(rule))if(!supported.has(key))throw Error('unsupported schema keyword: '+key);
    for(const group of ['$defs','properties'])for(const child of Object.values(rule[group]||{}))dialect(child,depth+1);
    for(const key of ['items','additionalProperties','if','then','else'])if(typeof rule[key]==='object')dialect(rule[key],depth+1);
    for(const key of ['allOf','oneOf','anyOf'])for(const child of rule[key]||[])dialect(child,depth+1);
  }
  dialect(schema);
  function check(instance, rule, at = '$') {
    if (rule.$ref) {
      if (!rule.$ref.startsWith('#/')) throw new Error('external schema references are forbidden');
      const target=rule.$ref.slice(2).split('/').reduce((s,k)=>s?.[k.replace(/~1/g,'/').replace(/~0/g,'~')],schema);
      if (!target) throw new Error('unresolved schema reference');
      check(instance,target,at);
    }
    function fail(reason) {throw new Error(`${at}: ${reason}`);}
    if (rule.type) {
      const actual=instance===null?'null':Array.isArray(instance)?'array':typeof instance;
      const wanted=Array.isArray(rule.type)?rule.type:[rule.type];
      if(!wanted.some(t=>t===actual||(t==='integer'&&Number.isSafeInteger(instance))))fail('wrong type');
      if(actual==='number'&&!Number.isFinite(instance))fail('nonfinite number');
    }
    if(Object.hasOwn(rule,'const')&&JSON.stringify(instance)!==JSON.stringify(rule.const))fail('wrong constant');
    if(rule.enum&&!rule.enum.some(x=>JSON.stringify(x)===JSON.stringify(instance)))fail('unknown value');
    if(typeof instance==='string'){
      if(rule.minLength!==undefined&&instance.length<rule.minLength)fail('short string');
      if(rule.maxLength!==undefined&&instance.length>rule.maxLength)fail('long string');
      if(rule.pattern&&!new RegExp(rule.pattern,'u').test(instance))fail('invalid string');
    }
    if(typeof instance==='number'){
      if(rule.minimum!==undefined&&instance<rule.minimum)fail('below minimum');
      if(rule.exclusiveMinimum!==undefined&&instance<=rule.exclusiveMinimum)fail('below exclusive minimum');
      if(rule.maximum!==undefined&&instance>rule.maximum)fail('above maximum');
    }
    if(Array.isArray(instance)){
      if(rule.minItems!==undefined&&instance.length<rule.minItems)fail('too few items');
      if(rule.uniqueItems&&new Set(instance.map(x=>JSON.stringify(x))).size!==instance.length)fail('duplicate items');
      if(rule.items)instance.forEach((x,i)=>check(x,rule.items,`${at}[${i}]`));
    } else if(instance!==null&&typeof instance==='object'){
      for(const key of rule.required||[])if(!Object.hasOwn(instance,key))fail(`missing ${key}`);
      for(const [key,x] of Object.entries(instance)){
        if(rule.properties?.[key])check(x,rule.properties[key],`${at}.${key}`);
        else if(rule.additionalProperties===false)fail(`unknown ${key}`);
        else if(rule.additionalProperties&&typeof rule.additionalProperties==='object')check(x,rule.additionalProperties,`${at}.${key}`);
      }
    }
    for(const child of rule.allOf||[])check(instance,child,at);
    function matches(child){try{check(instance,child,at);return true;}catch{return false;}}
    if(rule.oneOf&&rule.oneOf.filter(matches).length!==1)fail('ambiguous or invalid variant');
    if(rule.anyOf&&!rule.anyOf.some(matches))fail('no matching variant');
    if(rule.if){const next=matches(rule.if)?rule.then:rule.else;if(next)check(instance,next,at);}
  }
  check(value,schema);
  return value;
}
