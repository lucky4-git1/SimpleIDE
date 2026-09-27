export const getLanguageFromFile = (fileName) => {
  if (!fileName) return 'plaintext'
  const ext = fileName.split('.').pop().toLowerCase()
  
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript'
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'py':
      return 'python'
    case 'json':
      return 'json'
    case 'html':
    case 'htm':
      return 'html'
    case 'css':
      return 'css'
    case 'md':
    case 'mdx':
      return 'markdown'
    case 'yaml':
    case 'yml':
      return 'yaml'
    case 'xml':
      return 'xml'
    case 'sh':
    case 'bash':
      return 'shell'
    default:
      return 'plaintext'
  }
}
