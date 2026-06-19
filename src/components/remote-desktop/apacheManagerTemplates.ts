import type { ApacheConfigTemplate, ApacheTemplateValidationResult, ApacheTemplateVariable } from './apacheManagerTypes';

function valueOrDefault(values: Record<string, string>, name: string, fallback: string) {
  return values[name]?.trim() || fallback;
}

function validateApacheTemplateValue(
  name: string,
  type: ApacheTemplateVariable['type'],
  value: string,
  options: { disallowSpacesOrQuotes?: boolean; validateUrl?: boolean } = {},
): ApacheTemplateValidationResult {
  const stripped = value.trim();
  if (!stripped) return { valid: false, errorId: 'required' };
  if (/[\r\n<>]/.test(stripped)) return { valid: false, errorId: 'unsupportedCharacters' };
  if (options.disallowSpacesOrQuotes && /[\s'"]/.test(stripped)) {
    return { valid: false, errorId: 'spacesOrQuotes' };
  }
  if (options.validateUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(stripped);
    } catch {
      return { valid: false, errorId: 'invalidUrl' };
    }
    if (!parsedUrl.protocol || !parsedUrl.hostname) return { valid: false, errorId: 'invalidUrl' };
  }

  if (type === 'port') {
    if (!/^\d+$/.test(stripped)) return { valid: false, errorId: 'invalidPort' };
    const port = Number(stripped);
    if (port < 1 || port > 65535) return { valid: false, errorId: 'invalidPort' };
  }

  if (type === 'number' && !/^\d+$/.test(stripped)) {
    return { valid: false, errorId: 'invalidNumber' };
  }

  void name;
  return { valid: true, value: stripped };
}

function apacheValue(values: Record<string, string>, variable: ApacheTemplateVariable) {
  const rawValue = valueOrDefault(values, variable.name, variable.default);
  const result = variable.validate?.(rawValue) ?? validateApacheTemplateValue(variable.name, variable.type, rawValue);
  return result.value ?? rawValue.trim();
}

export function validateApacheTemplateValues(template: ApacheConfigTemplate, values: Record<string, string>) {
  for (const variable of template.variables) {
    const rawValue = valueOrDefault(values, variable.name, variable.default);
    const result = variable.validate?.(rawValue) ?? validateApacheTemplateValue(variable.name, variable.type, rawValue);
    if (!result.valid) {
      return { ...result, variable };
    }
  }

  return { valid: true as const };
}

const serverNameVariable: ApacheTemplateVariable = {
  name: 'SERVER_NAME',
  label: 'apache.variables.serverName',
  description: 'apache.variables.serverName.description',
  type: 'text',
  default: 'example.com',
  required: true,
  validate: (value) => validateApacheTemplateValue('SERVER_NAME', 'text', value, { disallowSpacesOrQuotes: true }),
};

const documentRootVariable: ApacheTemplateVariable = {
  name: 'DOCUMENT_ROOT',
  label: 'apache.variables.documentRoot',
  description: 'apache.variables.documentRoot.description',
  type: 'text',
  default: '/var/www/html',
  required: true,
  validate: (value) => validateApacheTemplateValue('DOCUMENT_ROOT', 'text', value, { disallowSpacesOrQuotes: true }),
};

const listenPortVariable: ApacheTemplateVariable = {
  name: 'LISTEN_PORT',
  label: 'apache.variables.listenPort',
  description: 'apache.variables.listenPort.description',
  type: 'port',
  default: '80',
  required: true,
  validate: (value) => validateApacheTemplateValue('LISTEN_PORT', 'port', value),
};

const proxyTargetVariable: ApacheTemplateVariable = {
  name: 'PROXY_TARGET',
  label: 'apache.variables.proxyTarget',
  description: 'apache.variables.proxyTarget.description',
  type: 'text',
  default: 'http://127.0.0.1:3000',
  required: true,
  validate: (value) => validateApacheTemplateValue('PROXY_TARGET', 'text', value, { disallowSpacesOrQuotes: true, validateUrl: true }),
};

const sslCertFileVariable: ApacheTemplateVariable = {
  name: 'SSL_CERT_FILE',
  label: 'apache.variables.sslCertFile',
  description: 'apache.variables.sslCertFile.description',
  type: 'text',
  default: '/etc/letsencrypt/live/example.com/fullchain.pem',
  required: true,
  validate: (value) => validateApacheTemplateValue('SSL_CERT_FILE', 'text', value, { disallowSpacesOrQuotes: true }),
};

const sslKeyFileVariable: ApacheTemplateVariable = {
  name: 'SSL_KEY_FILE',
  label: 'apache.variables.sslKeyFile',
  description: 'apache.variables.sslKeyFile.description',
  type: 'text',
  default: '/etc/letsencrypt/live/example.com/privkey.pem',
  required: true,
  validate: (value) => validateApacheTemplateValue('SSL_KEY_FILE', 'text', value, { disallowSpacesOrQuotes: true }),
};

const phpFpmSocketVariable: ApacheTemplateVariable = {
  name: 'PHP_FPM_SOCKET',
  label: 'apache.variables.phpFpmSocket',
  description: 'apache.variables.phpFpmSocket.description',
  type: 'text',
  default: 'unix:/run/php/php-fpm.sock',
  required: true,
  validate: (value) => validateApacheTemplateValue('PHP_FPM_SOCKET', 'text', value, { disallowSpacesOrQuotes: true }),
};

export const apacheConfigTemplates: ApacheConfigTemplate[] = [
  {
    id: 'static',
    name: 'apache.templates.static.name',
    description: 'apache.templates.static.description',
    icon: 'FileText',
    variables: [serverNameVariable, documentRootVariable, listenPortVariable],
    render: (values) => {
      const serverName = apacheValue(values, serverNameVariable);
      const documentRoot = apacheValue(values, documentRootVariable);
      const listenPort = apacheValue(values, listenPortVariable);

      return `<VirtualHost *:${listenPort}>
    ServerName ${serverName}
    DocumentRoot ${documentRoot}

    <Directory ${documentRoot}>
        Options Indexes FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

    ErrorLog \${APACHE_LOG_DIR}/${serverName}.error.log
    CustomLog \${APACHE_LOG_DIR}/${serverName}.access.log combined
</VirtualHost>`;
    },
  },
  {
    id: 'proxy',
    name: 'apache.templates.proxy.name',
    description: 'apache.templates.proxy.description',
    icon: 'Shuffle',
    variables: [serverNameVariable, listenPortVariable, proxyTargetVariable],
    render: (values) => {
      const serverName = apacheValue(values, serverNameVariable);
      const listenPort = apacheValue(values, listenPortVariable);
      const proxyTarget = apacheValue(values, proxyTargetVariable);

      return `<VirtualHost *:${listenPort}>
    ServerName ${serverName}

    ProxyPreserveHost On
    ProxyPass / ${proxyTarget}/
    ProxyPassReverse / ${proxyTarget}/

    ErrorLog \${APACHE_LOG_DIR}/${serverName}.error.log
    CustomLog \${APACHE_LOG_DIR}/${serverName}.access.log combined
</VirtualHost>`;
    },
  },
  {
    id: 'ssl',
    name: 'apache.templates.ssl.name',
    description: 'apache.templates.ssl.description',
    icon: 'ShieldCheck',
    variables: [serverNameVariable, documentRootVariable, sslCertFileVariable, sslKeyFileVariable],
    render: (values) => {
      const serverName = apacheValue(values, serverNameVariable);
      const documentRoot = apacheValue(values, documentRootVariable);
      const sslCertFile = apacheValue(values, sslCertFileVariable);
      const sslKeyFile = apacheValue(values, sslKeyFileVariable);

      return `<VirtualHost *:443>
    ServerName ${serverName}
    DocumentRoot ${documentRoot}

    SSLEngine On
    SSLCertificateFile ${sslCertFile}
    SSLCertificateKeyFile ${sslKeyFile}

    <Directory ${documentRoot}>
        Options Indexes FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

    ErrorLog \${APACHE_LOG_DIR}/${serverName}.ssl.error.log
    CustomLog \${APACHE_LOG_DIR}/${serverName}.ssl.access.log combined
</VirtualHost>`;
    },
  },
  {
    id: 'php',
    name: 'apache.templates.php.name',
    description: 'apache.templates.php.description',
    icon: 'Code2',
    variables: [serverNameVariable, documentRootVariable, listenPortVariable, phpFpmSocketVariable],
    render: (values) => {
      const serverName = apacheValue(values, serverNameVariable);
      const documentRoot = apacheValue(values, documentRootVariable);
      const listenPort = apacheValue(values, listenPortVariable);
      const phpFpmSocket = apacheValue(values, phpFpmSocketVariable);

      return `<VirtualHost *:${listenPort}>
    ServerName ${serverName}
    DocumentRoot ${documentRoot}

    <Directory ${documentRoot}>
        Options FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

    <FilesMatch "\\.php$">
        SetHandler "proxy:fcgi://${phpFpmSocket}"
    </FilesMatch>

    DirectoryIndex index.php index.html
    ErrorLog \${APACHE_LOG_DIR}/${serverName}.error.log
    CustomLog \${APACHE_LOG_DIR}/${serverName}.access.log combined
</VirtualHost>`;
    },
  },
];
