<?php
namespace Mona\MonaPay\Model\Config\Source;

use Magento\Framework\Data\OptionSourceInterface;

class OwnerType implements OptionSourceInterface
{
    public function toOptionArray(): array
    {
        return [['value' => 'PER', 'label' => 'PER'], ['value' => 'ORG', 'label' => 'ORG']];
    }
}
